import { describe, expect, it } from 'vitest';
import { admitAppSignaturePreparation } from './app-signature-preparation.js';
import {
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
  resolveImageSigningIdentity,
} from './index.js';

const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const app = resolveDeploymentLaneAuthority(target, 'app');
function fixture() {
  const trust = {
    assetManifestSha256: 'a'.repeat(64),
    trustRootSha256: 'b'.repeat(64),
    trustPolicySha256: 'c'.repeat(64),
    verifierVersion: 'notation@1.3.2+aws-signer-plugin@1.0.2292',
    notationVersion: '1.3.2',
    awsSignerPluginVersion: '1.0.2292',
    ecrCredentialHelperVersion: '0.12.0',
  };
  const expected = {
    buildId: `${app.names.terraformPlanProject}:11111111-2222-4333-8444-555555555555`,
    pipelineExecutionId: '22222222-3333-4444-8555-666666666666',
    proverImageUri: `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/${app.names.proverRepository}@sha256:${'d'.repeat(64)}`,
    proverReleaseKey: 'promotions/prover/current.json',
    sourceSha: 'f'.repeat(40),
    trust,
  };
  const record = {
    evidenceType: 'app-image-signature-preparation',
    targetKey: target.targetKey,
    buildId: expected.buildId,
    pipelineExecutionId: expected.pipelineExecutionId,
    sourceSha: expected.sourceSha,
    proverImageUri: expected.proverImageUri,
    proverReleaseKey: expected.proverReleaseKey,
    signingProfileArn: resolveImageSigningIdentity(target).signingProfileArn,
    verifierPackage: {
      bucket: app.names.appRetainedArtifactBucket,
      key: `${app.names.lambdaArtifactPrefix}/${expected.sourceSha}/image-signature-verifier.zip`,
      versionId: 'immutable-verifier-package',
      sha256: '1'.repeat(64),
      sourceCodeHash: Buffer.from('1'.repeat(64), 'hex').toString('base64'),
      assetManifestSha256: trust.assetManifestSha256,
      trustRootSha256: trust.trustRootSha256,
    },
    verification: {
      result: 'VERIFIED',
      mode: 'cryptographic',
      verifierVersion: trust.verifierVersion,
      assetManifestSha256: trust.assetManifestSha256,
      trustPolicySha256: trust.trustPolicySha256,
      verifierAssets: {
        notationVersion: trust.notationVersion,
        awsSignerPluginVersion: trust.awsSignerPluginVersion,
        ecrCredentialHelperVersion: trust.ecrCredentialHelperVersion,
        trustRootSha256: trust.trustRootSha256,
      },
    },
  };
  return { expected, record };
}

describe('App native signature preparation', () => {
  it('binds successful verification to source, build, selected release and deployable package', () => {
    const { record, expected } = fixture();
    const admitted = admitAppSignaturePreparation(record, expected, target.targetKey);
    expect(admitted).toEqual(record);
    expect(Object.isFrozen(admitted.verifierPackage)).toBe(true);
    expect(admitted).not.toHaveProperty('lambda');
    expect(admitted).not.toHaveProperty('functionVersion');
  });

  it.each(['sourceSha', 'pipelineExecutionId', 'buildId', 'proverReleaseKey', 'proverImageUri'] as const)(
    'rejects stale or substituted %s even when the native result says VERIFIED',
    (field) => {
      const { record, expected } = fixture();
      expect(() =>
        admitAppSignaturePreparation({ ...record, [field]: 'different' }, expected, target.targetKey),
      ).toThrow(/detached/iu);
    },
  );

  it.each(['VERIFICATION_FAILED', 'VERIFIER_TIMEOUT', 'VERIFIER_ERROR', 'PENDING'])(
    'never admits a %s result',
    (result) => {
      const { record, expected } = fixture();
      expect(() =>
        admitAppSignaturePreparation(
          { ...record, verification: { ...record.verification, result } },
          expected,
          target.targetKey,
        ),
      ).toThrow(/successful cryptographic/iu);
    },
  );

  it('rejects different trust, native assets and package bytes', () => {
    const { record, expected } = fixture();
    const changed = [
      { ...record, verification: { ...record.verification, trustPolicySha256: '0'.repeat(64) } },
      {
        ...record,
        verification: {
          ...record.verification,
          verifierAssets: { ...record.verification.verifierAssets, awsSignerPluginVersion: 'unknown' },
        },
      },
      { ...record, verifierPackage: { ...record.verifierPackage, assetManifestSha256: '0'.repeat(64) } },
      { ...record, verifierPackage: { ...record.verifierPackage, sha256: '0'.repeat(64) } },
      { ...record, verifierPackage: { ...record.verifierPackage, versionId: 'null' } },
    ];
    for (const value of changed)
      expect(() => admitAppSignaturePreparation(value, expected, target.targetKey)).toThrow();
  });

  it('refuses retired Lambda preflight evidence and hostile input without invoking traps', () => {
    const { record, expected } = fixture();
    expect(() =>
      admitAppSignaturePreparation({ ...record, lambda: { functionVersion: '42' } }, expected, target.targetKey),
    ).toThrow();
    let calls = 0;
    const proxy = new Proxy(record, {
      ownKeys() {
        calls++;
        return [];
      },
    });
    expect(() => admitAppSignaturePreparation(proxy, expected, target.targetKey)).toThrow(/proxy/iu);
    expect(calls).toBe(0);
  });
});
