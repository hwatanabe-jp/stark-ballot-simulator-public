import { canonicalRecordJson, deepFreeze, parseGitCommitSha, requireString } from './internal.js';
import { admitObjectReference, packageRecord, storedBytesSha256 } from './plan-package.js';
import { parseRootCheckpoint } from './root-checkpoint.js';
import {
  admitImageCandidate,
  admitImagePromotion,
  assertImagePromotionCandidate,
  promotionKey,
  candidateKey,
} from './release-ledger.js';
/** @param {unknown} value @param {'prover'|'toolchain'} kind @param {string} targetKey */
export function admitAppImageSelection(value, kind, targetKey) {
  const input = packageRecord(value, ['candidate', 'promotion', 'reference', 'etag'], 'App image selection');
  const candidate = admitImageCandidate(input['candidate'], targetKey);
  const promotion = admitImagePromotion(input['promotion'], targetKey, kind);
  assertImagePromotionCandidate(promotion, candidate);
  const reference = admitObjectReference(input['reference']);
  if (
    candidate.kind !== kind ||
    reference.key !== promotionKey(targetKey, kind) ||
    storedBytesSha256(canonicalRecordJson(promotion)) !== reference.sha256 ||
    promotion.candidate.key !== candidateKey(candidate) ||
    storedBytesSha256(canonicalRecordJson(candidate)) !== promotion.candidate.sha256
  )
    throw new Error('App image selection immutable chain mismatch.');
  return deepFreeze({ candidate, promotion, reference, etag: requireString(input['etag'], 'Image ETag') });
}
/** @param {unknown} value @param {string} targetKey */
export function admitAppReleaseSelection(value, targetKey) {
  const input = packageRecord(
    value,
    ['foundation', 'prover', 'toolchain', 'selectedSourceSha'],
    'App release selection',
  );
  const selectedSourceSha = parseGitCommitSha(input['selectedSourceSha']);
  const foundationInput = packageRecord(
    input['foundation'],
    ['checkpoint', 'reference', 'etag'],
    'Foundation checkpoint selection',
  );
  const foundationReference = admitObjectReference(foundationInput['reference']);
  const checkpoint = parseRootCheckpoint(
    canonicalRecordJson(foundationInput['checkpoint']),
    foundationReference,
    targetKey,
    'foundation',
  );
  if (checkpoint.root !== 'foundation') throw new Error('Foundation root mismatch.');
  const foundation = {
    checkpoint,
    reference: foundationReference,
    etag: requireString(foundationInput['etag'], 'Foundation ETag'),
  };
  const toolchain = admitAppImageSelection(input['toolchain'], 'toolchain', targetKey);
  const prover = admitAppImageSelection(input['prover'], 'prover', targetKey);
  if (
    prover.candidate.kind !== 'prover' ||
    toolchain.candidate.kind !== 'toolchain' ||
    prover.candidate.evidence.toolchain.imageUri !== toolchain.candidate.imageUri
  )
    throw new Error('Current Toolchain digest is incompatible with Prover provenance.');
  return deepFreeze({
    selectedSourceSha,
    foundation,
    toolchain,
    prover,
    selectedReleaseAuthority: {
      foundationAcceptanceKey: foundation.reference.key,
      foundationContractHash: checkpoint.outputs.consumerContract.foundationContractHash,
      proverImageDigest: prover.candidate.imageUri.split('@')[1],
      proverImageUri: prover.candidate.imageUri,
      proverReleaseKey: prover.reference.key,
      toolchainImageDigest: toolchain.candidate.imageUri.split('@')[1],
      toolchainReleaseKey: toolchain.reference.key,
    },
  });
}
