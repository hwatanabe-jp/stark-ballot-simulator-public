import { rejectProxyTree, snapshotExactRecord } from './descriptor-snapshot.js';
import {
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
  resolveImageSigningIdentity,
} from './index.js';
import {
  deepFreeze,
  parseDigestPinnedImageReference,
  parseGitCommitSha,
  parseS3VersionId,
  parseSha256,
  requireGroupedLowercaseUuid,
  requireString,
} from './internal.js';
import { promotionKey } from './release-ledger.js';

const PACKAGE_KEYS = [
  'assetManifestSha256',
  'bucket',
  'key',
  'sha256',
  'sourceCodeHash',
  'trustRootSha256',
  'versionId',
];
const TRUST_KEYS = [
  'assetManifestSha256',
  'awsSignerPluginVersion',
  'ecrCredentialHelperVersion',
  'notationVersion',
  'trustPolicySha256',
  'trustRootSha256',
  'verifierVersion',
];

/** @param {unknown} value @param {unknown} sourceShaValue @param {unknown} expectedTargetKey */
export function admitAppVerifierPackage(value, sourceShaValue, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'App signature expected target'));
  const app = resolveDeploymentLaneAuthority(target, 'app');
  const sourceSha = parseGitCommitSha(sourceShaValue, 'Verifier package source');
  rejectProxyTree(value, 'App verifier package');
  const input = snapshotExactRecord(value, PACKAGE_KEYS, 'App verifier package');
  const sha256 = parseSha256(input['sha256'], 'Verifier package SHA-256');
  if (
    input['bucket'] !== app.names.appRetainedArtifactBucket ||
    input['key'] !== `${app.names.lambdaArtifactPrefix}/${sourceSha}/image-signature-verifier.zip` ||
    input['sourceCodeHash'] !== Buffer.from(sha256, 'hex').toString('base64')
  )
    throw new Error('App verifier package is detached from its target, source, or bytes.');
  return deepFreeze({
    bucket: app.names.appRetainedArtifactBucket,
    key: `${app.names.lambdaArtifactPrefix}/${sourceSha}/image-signature-verifier.zip`,
    versionId: parseS3VersionId(input['versionId']),
    sha256,
    sourceCodeHash: Buffer.from(sha256, 'hex').toString('base64'),
    assetManifestSha256: parseSha256(input['assetManifestSha256'], 'Verifier asset manifest SHA-256'),
    trustRootSha256: parseSha256(input['trustRootSha256'], 'Verifier trust root SHA-256'),
  });
}

/**
 * Admit CodeBuild's cryptographic result against the source-owned native trust
 * manifest. This preparation makes no claim about a deployed Lambda version.
 *
 * @param {unknown} value
 * @param {unknown} expectedValue
 * @param {unknown} expectedTargetKey
 */
export function admitAppSignaturePreparation(value, expectedValue, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'App signature expected target'));
  const app = resolveDeploymentLaneAuthority(target, 'app');
  rejectProxyTree(value, 'App signature preparation');
  rejectProxyTree(expectedValue, 'Expected App signature preparation');
  const expected = snapshotExactRecord(
    expectedValue,
    ['buildId', 'pipelineExecutionId', 'proverImageUri', 'proverReleaseKey', 'sourceSha', 'trust'],
    'Expected App signature preparation',
  );
  const expectedTrust = snapshotExactRecord(expected['trust'], TRUST_KEYS, 'Source-owned verifier trust');
  const input = snapshotExactRecord(
    value,
    [
      'buildId',
      'evidenceType',
      'pipelineExecutionId',
      'proverImageUri',
      'proverReleaseKey',
      'signingProfileArn',
      'sourceSha',
      'targetKey',
      'verification',
      'verifierPackage',
    ],
    'App signature preparation',
  );
  if (input['evidenceType'] !== 'app-image-signature-preparation' || input['targetKey'] !== target.targetKey) {
    throw new Error('App signature preparation target or type is invalid.');
  }
  for (const field of ['buildId', 'pipelineExecutionId', 'proverImageUri', 'proverReleaseKey', 'sourceSha']) {
    if (input[field] !== expected[field])
      throw new Error(`App signature preparation ${field} is detached from the selected execution.`);
  }
  const sourceSha = parseGitCommitSha(input['sourceSha'], 'Signature preparation source');
  const pipelineExecutionId = requireGroupedLowercaseUuid(input['pipelineExecutionId'], 'App pipeline execution');
  const buildId = requireString(input['buildId'], 'App signature preparation build');
  const buildPrefix = `${app.names.terraformPlanProject}:`;
  if (!buildId.startsWith(buildPrefix)) throw new Error('Signature preparation belongs to another project.');
  requireGroupedLowercaseUuid(buildId.slice(buildPrefix.length), 'Signature preparation build ID');
  const proverImageUri = parseDigestPinnedImageReference(input['proverImageUri'], {
    partition: target.partition,
    accountId: target.accountId,
    region: target.region,
    repository: app.names.proverRepository,
  }).imageUri;
  const proverReleaseKey = promotionKey(target.targetKey, 'prover');
  if (input['proverReleaseKey'] !== proverReleaseKey)
    throw new Error('Signature preparation Prover promotion key mismatch.');
  const signingProfileArn = resolveImageSigningIdentity(target).signingProfileArn;
  if (input['signingProfileArn'] !== signingProfileArn)
    throw new Error('Signature preparation signing profile is detached.');
  const verifierPackage = admitAppVerifierPackage(input['verifierPackage'], sourceSha, target.targetKey);
  const verification = admitNativeSignatureResult(input['verification'], expectedTrust);
  if (
    verifierPackage.assetManifestSha256 !== expectedTrust['assetManifestSha256'] ||
    verifierPackage.trustRootSha256 !== expectedTrust['trustRootSha256']
  ) {
    throw new Error('Runtime verifier package does not contain the verified native assets.');
  }
  return deepFreeze({
    evidenceType: /** @type {const} */ ('app-image-signature-preparation'),
    targetKey: target.targetKey,
    sourceSha,
    pipelineExecutionId,
    buildId,
    proverImageUri,
    proverReleaseKey,
    signingProfileArn,
    verifierPackage,
    verification,
  });
}

/** @param {unknown} value @param {unknown} expectedTrustValue */
export function admitNativeSignatureResult(value, expectedTrustValue) {
  rejectProxyTree(value, 'Native signature result');
  rejectProxyTree(expectedTrustValue, 'Source-owned verifier trust');
  const expectedTrust = snapshotExactRecord(expectedTrustValue, TRUST_KEYS, 'Source-owned verifier trust');
  for (const field of ['assetManifestSha256', 'trustPolicySha256', 'trustRootSha256']) {
    parseSha256(expectedTrust[field], `Source-owned verifier ${field}`);
  }
  for (const field of ['awsSignerPluginVersion', 'ecrCredentialHelperVersion', 'notationVersion', 'verifierVersion']) {
    requireString(expectedTrust[field], `Source-owned verifier ${field}`);
  }
  const verification = snapshotExactRecord(
    value,
    ['assetManifestSha256', 'mode', 'result', 'trustPolicySha256', 'verifierAssets', 'verifierVersion'],
    'Native image signature result',
  );
  const assets = snapshotExactRecord(
    verification['verifierAssets'],
    ['awsSignerPluginVersion', 'ecrCredentialHelperVersion', 'notationVersion', 'trustRootSha256'],
    'Native image signature assets',
  );
  if (verification['mode'] !== 'cryptographic' || verification['result'] !== 'VERIFIED') {
    throw new Error('App preparation requires successful cryptographic image verification.');
  }
  for (const field of ['assetManifestSha256', 'trustPolicySha256', 'verifierVersion']) {
    if (verification[field] !== expectedTrust[field])
      throw new Error(`Native verifier ${field} is detached from the selected source.`);
  }
  for (const field of ['awsSignerPluginVersion', 'ecrCredentialHelperVersion', 'notationVersion', 'trustRootSha256']) {
    if (assets[field] !== expectedTrust[field])
      throw new Error(`Native verifier ${field} is detached from the selected source.`);
  }
  return deepFreeze({
    result: /** @type {const} */ ('VERIFIED'),
    mode: /** @type {const} */ ('cryptographic'),
    verifierVersion: requireString(verification['verifierVersion'], 'Verified native version'),
    assetManifestSha256: parseSha256(verification['assetManifestSha256'], 'Verified native manifest'),
    trustPolicySha256: parseSha256(verification['trustPolicySha256'], 'Verified native trust policy'),
    verifierAssets: {
      notationVersion: requireString(assets['notationVersion'], 'Verified Notation version'),
      awsSignerPluginVersion: requireString(assets['awsSignerPluginVersion'], 'Verified Signer plugin version'),
      ecrCredentialHelperVersion: requireString(assets['ecrCredentialHelperVersion'], 'Verified ECR helper version'),
      trustRootSha256: parseSha256(assets['trustRootSha256'], 'Verified native trust root'),
    },
  });
}
