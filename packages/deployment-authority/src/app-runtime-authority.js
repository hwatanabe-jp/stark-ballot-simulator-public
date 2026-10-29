import { deepFreeze, parseSha256, parseImageDigest, requireString } from './internal.js';
import {
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
  parseDigestPinnedImageReference,
} from './index.js';
import { admitObjectReference, packageRecord } from './plan-package.js';
import { deriveRootCheckpointKey } from './root-checkpoint.js';
import { promotionKey } from './release-ledger.js';
import { admitAppVerifierPackage } from './app-signature-preparation.js';
/** @param {unknown} value @param {string} targetKey */
export function admitAppRuntimeReleaseAuthority(value, targetKey) {
  const target = resolveAllowedDeploymentTarget(targetKey);
  const names = resolveDeploymentLaneAuthority(target, 'app').names;
  const input = packageRecord(
    value,
    [
      'foundationAcceptanceKey',
      'foundationContractHash',
      'toolchainReleaseKey',
      'proverReleaseKey',
      'toolchainImage',
      'proverImage',
      'zkvm',
    ],
    'App runtime release authority',
  );
  if (
    input['foundationAcceptanceKey'] !== deriveRootCheckpointKey(targetKey, 'foundation') ||
    input['toolchainReleaseKey'] !== promotionKey(targetKey, 'toolchain') ||
    input['proverReleaseKey'] !== promotionKey(targetKey, 'prover')
  )
    throw new Error('App runtime dependency keys mismatch.');
  /** @param {'toolchain'|'prover'} kind */
  function image(kind) {
    const record = packageRecord(input[`${kind}Image`], ['imageUri', 'imageDigest'], 'App runtime image');
    const parsed = parseDigestPinnedImageReference(record['imageUri'], {
      partition: target.partition,
      accountId: target.accountId,
      region: target.region,
      repository: names[`${kind}Repository`],
    });
    if (parsed.digest !== parseImageDigest(record['imageDigest']))
      throw new Error('App runtime image digest mismatch.');
    return { imageUri: parsed.imageUri, imageDigest: parsed.digest };
  }
  const zkvm = packageRecord(
    input['zkvm'],
    [
      'applicationZkvmContractHash',
      'proverZkvmContractHash',
      'zkvmContractHash',
      'expectedImageId',
      'methodVersion',
      'imageIdVariant',
      'imageIdMappingSha256',
      'failureMarkerContractSha256',
    ],
    'App runtime zkVM contract',
  );
  const hash = parseSha256(zkvm['zkvmContractHash']);
  if (
    zkvm['applicationZkvmContractHash'] !== hash ||
    zkvm['proverZkvmContractHash'] !== hash ||
    zkvm['imageIdVariant'] !== 'default' ||
    typeof zkvm['methodVersion'] !== 'number' ||
    !Number.isSafeInteger(zkvm['methodVersion']) ||
    zkvm['methodVersion'] < 1
  )
    throw new Error('App runtime zkVM contract mismatch.');
  return deepFreeze({
    foundationAcceptanceKey: deriveRootCheckpointKey(targetKey, 'foundation'),
    foundationContractHash: parseSha256(input['foundationContractHash']),
    toolchainReleaseKey: promotionKey(targetKey, 'toolchain'),
    proverReleaseKey: promotionKey(targetKey, 'prover'),
    toolchainImage: image('toolchain'),
    proverImage: image('prover'),
    zkvm: {
      applicationZkvmContractHash: hash,
      proverZkvmContractHash: hash,
      zkvmContractHash: hash,
      expectedImageId: requireString(zkvm['expectedImageId'], 'ImageID', /^0x[0-9a-f]{64}$/u),
      methodVersion: zkvm['methodVersion'],
      imageIdVariant: /** @type {const} */ ('default'),
      imageIdMappingSha256: parseSha256(zkvm['imageIdMappingSha256']),
      failureMarkerContractSha256: parseSha256(zkvm['failureMarkerContractSha256']),
    },
  });
}
/** @param {unknown} value @param {unknown} releaseAuthorityValue @param {string} sourceSha @param {string} targetKey */
export function admitAppRuntimeVerifierAuthority(value, releaseAuthorityValue, sourceSha, targetKey) {
  const release = admitAppRuntimeReleaseAuthority(releaseAuthorityValue, targetKey);
  const input = packageRecord(
    value,
    ['confirmedImageIdMapping', 'signaturePreflight'],
    'App runtime verifier authority',
  );
  const expected = {
    proverReleaseKey: release.proverReleaseKey,
    proverImageDigest: release.proverImage.imageDigest,
    expectedImageId: release.zkvm.expectedImageId,
    methodVersion: release.zkvm.methodVersion,
    imageIdVariant: release.zkvm.imageIdVariant,
    imageIdMappingSha256: release.zkvm.imageIdMappingSha256,
    zkvmContractHash: release.zkvm.zkvmContractHash,
  };
  const mapping = packageRecord(input['confirmedImageIdMapping'], Object.keys(expected), 'Confirmed ImageID mapping');
  for (const [key, value] of Object.entries(expected))
    if (mapping[key] !== value) throw new Error('Confirmed ImageID mapping mismatch.');
  const preflight = packageRecord(
    input['signaturePreflight'],
    [
      'result',
      'selectedApplicationSourceSha',
      'proverReleaseKey',
      'proverImageUri',
      'managedSigningStatus',
      'evidence',
      'verifierIdentitySha256',
      'verifierPackage',
    ],
    'Signature preflight',
  );
  if (
    preflight['result'] !== 'passed' ||
    preflight['managedSigningStatus'] !== 'COMPLETE' ||
    preflight['selectedApplicationSourceSha'] !== sourceSha ||
    preflight['proverReleaseKey'] !== release.proverReleaseKey ||
    preflight['proverImageUri'] !== release.proverImage.imageUri
  )
    throw new Error('Signature preflight runtime binding mismatch.');
  return deepFreeze({
    confirmedImageIdMapping: expected,
    signaturePreflight: {
      result: /** @type {const} */ ('passed'),
      selectedApplicationSourceSha: sourceSha,
      proverReleaseKey: release.proverReleaseKey,
      proverImageUri: release.proverImage.imageUri,
      managedSigningStatus: /** @type {const} */ ('COMPLETE'),
      evidence: admitObjectReference(preflight['evidence']),
      verifierIdentitySha256: parseSha256(preflight['verifierIdentitySha256']),
      verifierPackage: admitAppVerifierPackage(preflight['verifierPackage'], sourceSha, targetKey),
    },
  });
}
