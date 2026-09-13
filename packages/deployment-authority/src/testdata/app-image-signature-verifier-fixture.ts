import { Buffer } from 'node:buffer';

import { canonicalJsonSha256 } from '../internal.js';
import {
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
  resolveImageSigningIdentity,
} from '../index.js';

function buildImageSignatureVerifierFixture(targetKey: string) {
  const target = resolveAllowedDeploymentTarget(targetKey);
  const app = resolveDeploymentLaneAuthority(target, 'app');
  const signing = resolveImageSigningIdentity(target);
  const sourceSha = 'a'.repeat(40);
  const retainedSourceSha = 'f'.repeat(40);
  const zipSha256 = 'b'.repeat(64);
  const retainedZipSha256 = '9'.repeat(64);
  const codeSha256 = Buffer.from(zipSha256, 'hex').toString('base64');
  const retainedCodeSha256 = Buffer.from(retainedZipSha256, 'hex').toString('base64');
  const awsConfigSha256 = Buffer.from('1'.repeat(64), 'hex').toString('base64');
  const assetManifestSha256 = 'c'.repeat(64);
  const trustRootSha256 = 'd'.repeat(64);
  const proverImageDigest = `sha256:${'e'.repeat(64)}`;
  const functionName = app.names.signatureVerifierFunction;
  const functionArn = `arn:${target.partition}:lambda:${target.region}:${target.accountId}:function:${functionName}`;
  const aliasAwsRevisionIds = {
    preflight: '43c144a8-b3ba-4cb0-bdc7-b4590855065f',
    runtime: 'c9227b78-34fc-4e75-a050-98e15e368e99',
  } as const;

  function buildVerifierConfigurationAuthority() {
    return {
      architectures: ['x86_64'],
      dead_letter_target_arn: null,
      environment: {
        IMAGE_SIGNATURE_VERIFIER_EXPECTED_ASSET_MANIFEST_SHA256: assetManifestSha256,
        IMAGE_SIGNATURE_VERIFIER_EXPECTED_IMAGE_DIGEST: proverImageDigest,
        IMAGE_SIGNATURE_VERIFIER_EXPECTED_REGION: target.region,
        IMAGE_SIGNATURE_VERIFIER_EXPECTED_REGISTRY_ID: target.accountId,
        IMAGE_SIGNATURE_VERIFIER_EXPECTED_REPOSITORY_NAME: signing.repositories.prover,
        IMAGE_SIGNATURE_VERIFIER_EXPECTED_SIGNING_PROFILE_ARN: signing.signingProfileArn,
        IMAGE_SIGNATURE_VERIFIER_EXPECTED_TRUST_ROOT_SHA256: trustRootSha256,
        IMAGE_SIGNATURE_VERIFIER_HANDLER_DEADLINE_MS: '100000',
        IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPT_TIMEOUT_MS: '4000',
        IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPTS: '4',
        IMAGE_SIGNATURE_VERIFIER_STATUS_RETRY_DELAY_MS: '5000',
        IMAGE_SIGNATURE_VERIFIER_TIMEOUT_MS: '60000',
        NODE_ENV: 'production',
      },
      ephemeral_storage_mb: 1024,
      handler: 'index.handler',
      kms_key_arn: null,
      layers: [],
      logging_config: {
        application_log_level: 'INFO',
        log_format: 'JSON',
        log_group: `/aws/lambda/${functionName}`,
        system_log_level: 'INFO',
      },
      memory_size_mb: 1024,
      package_type: 'Zip',
      role_arn: `arn:${target.partition}:iam::${target.accountId}:role/${app.names.signatureVerifierRole}`,
      runtime: 'nodejs24.x',
      timeout_seconds: 120,
      tracing_mode: 'PassThrough',
      vpc_config: {
        ipv6_allowed_for_dual_stack: false,
        security_group_ids: [],
        subnet_ids: [],
        vpc_id: null,
      },
    };
  }

  function verifierConfigurationAuthority(): ReturnType<typeof buildVerifierConfigurationAuthority> {
    return buildVerifierConfigurationAuthority();
  }

  function buildImmutablePackage() {
    return {
      assetManifestSha256,
      codeSha256,
      s3Bucket: app.names.appRetainedArtifactBucket,
      s3Key: `${app.names.lambdaArtifactPrefix}/${sourceSha}/image-signature-verifier.zip`,
      s3ObjectVersionId: 'immutable-package-object',
      trustRootSha256,
      zipSha256,
    };
  }

  function immutablePackage(): ReturnType<typeof buildImmutablePackage> {
    return buildImmutablePackage();
  }

  function buildResolvedS3Object() {
    const verifierPackage = immutablePackage();
    return {
      s3Bucket: verifierPackage.s3Bucket,
      s3Key: verifierPackage.s3Key,
      s3ObjectVersionId: verifierPackage.s3ObjectVersionId,
    };
  }

  function resolvedS3Object(): ReturnType<typeof buildResolvedS3Object> {
    return buildResolvedS3Object();
  }

  function buildRetainedRuntimeFunction() {
    const configurationAuthority = verifierConfigurationAuthority();
    return {
      assetManifestSha256,
      awsConfigSha256,
      codeSha256: retainedCodeSha256,
      description: '',
      functionConfigurationAuthority: configurationAuthority,
      functionConfigurationSha256: canonicalJsonSha256(configurationAuthority),
      functionVersion: '39',
      resolvedS3Object: {
        s3Bucket: app.names.appRetainedArtifactBucket,
        s3Key: `${app.names.lambdaArtifactPrefix}/${retainedSourceSha}/image-signature-verifier.zip`,
        s3ObjectVersionId: 'retained-package-object',
      },
      trustRootSha256,
      zipSha256: retainedZipSha256,
    };
  }

  function retainedRuntimeFunction(): ReturnType<typeof buildRetainedRuntimeFunction> {
    return buildRetainedRuntimeFunction();
  }

  function buildDesiredState() {
    const configurationAuthority = verifierConfigurationAuthority();
    return {
      accountId: target.accountId,
      aliases: {
        preflight: {
          aliasArn: `${functionArn}:preflight`,
          description: 'Qualified non-accepting cryptographic verifier preflight',
          name: 'preflight',
          target: { kind: 'reconciled-function' },
        },
        runtime: {
          aliasArn: `${functionArn}:runtime`,
          description: 'Qualified runtime cryptographic verifier gate',
          name: 'runtime',
          target: { function: retainedRuntimeFunction(), kind: 'retained-function' },
        },
      },
      expectedFunctionVersion: '42',
      functionArn,
      functionConfigurationAuthority: configurationAuthority,
      functionConfigurationSha256: canonicalJsonSha256(configurationAuthority),
      functionName,
      package: immutablePackage(),
      region: target.region,
      signatureAuthority: {
        proverImageDigest,
        proverRepositoryName: signing.repositories.prover,
        signingProfileArn: signing.signingProfileArn,
      },
      sourceSha,
      targetKey: target.targetKey,
    };
  }

  function desiredState(): ReturnType<typeof buildDesiredState> {
    return buildDesiredState();
  }

  function buildMutableFunction(overrides: Record<string, unknown> = {}) {
    return {
      awsConfigSha256,
      awsRevisionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      codeSha256,
      description: '',
      functionArn,
      functionConfigurationAuthority: verifierConfigurationAuthority(),
      functionConfigurationSha256: desiredState().functionConfigurationSha256,
      functionName,
      lastModified: '2026-08-15T00:00:00.000+0000',
      lastUpdateStatus: 'Successful',
      resolvedS3Object: resolvedS3Object(),
      state: 'Active',
      ...overrides,
    };
  }

  function mutableFunction(overrides: Record<string, unknown> = {}): ReturnType<typeof buildMutableFunction> {
    return buildMutableFunction(overrides);
  }

  function buildImmutableFunction(functionVersion = '42', overrides: Record<string, unknown> = {}) {
    const observedOverrides = { ...overrides };
    delete observedOverrides['assetManifestSha256'];
    delete observedOverrides['trustRootSha256'];
    delete observedOverrides['zipSha256'];
    return {
      awsConfigSha256,
      awsRevisionId: 'ffffffff-1111-4222-8333-444444444444',
      codeSha256,
      description: '',
      functionArn: `${functionArn}:${functionVersion}`,
      functionConfigurationAuthority: verifierConfigurationAuthority(),
      functionConfigurationSha256: desiredState().functionConfigurationSha256,
      functionName,
      functionVersion,
      lastModified: '2026-08-15T00:00:00.000+0000',
      resolvedS3Object: resolvedS3Object(),
      state: 'Active',
      ...observedOverrides,
    };
  }

  function immutableFunction(
    functionVersion = '42',
    overrides: Record<string, unknown> = {},
  ): ReturnType<typeof buildImmutableFunction> {
    return buildImmutableFunction(functionVersion, overrides);
  }

  function buildAlias(name: 'preflight' | 'runtime', functionVersion: string) {
    const desired = desiredState().aliases[name];
    return {
      aliasArn: desired.aliasArn,
      awsRevisionId: aliasAwsRevisionIds[name],
      description: desired.description,
      functionVersion,
      name,
      routingWeights: {},
    };
  }

  function alias(name: 'preflight' | 'runtime', functionVersion: string): ReturnType<typeof buildAlias> {
    return buildAlias(name, functionVersion);
  }

  function buildObservation(overrides: Record<string, unknown> = {}) {
    return {
      aliases: { preflight: alias('preflight', '39'), runtime: alias('runtime', '39') },
      immutableFunctions: {
        items: [
          immutableFunction('39', retainedRuntimeFunction()),
          immutableFunction('40', {
            codeSha256: Buffer.from('7'.repeat(64), 'hex').toString('base64'),
            resolvedS3Object: { ...resolvedS3Object(), s3ObjectVersionId: 'superseded-package-object-40' },
          }),
          immutableFunction('41', {
            codeSha256: Buffer.from('8'.repeat(64), 'hex').toString('base64'),
            resolvedS3Object: { ...resolvedS3Object(), s3ObjectVersionId: 'superseded-package-object-41' },
          }),
        ],
        unreadNextMarker: null,
      },
      mutableFunction: mutableFunction(),
      ...overrides,
    };
  }

  function observation(overrides: Record<string, unknown> = {}): ReturnType<typeof buildObservation> {
    return buildObservation(overrides);
  }

  return {
    target,
    app,
    signing,
    sourceSha,
    retainedSourceSha,
    zipSha256,
    retainedZipSha256,
    codeSha256,
    retainedCodeSha256,
    awsConfigSha256,
    assetManifestSha256,
    trustRootSha256,
    proverImageDigest,
    functionName,
    functionArn,
    aliasAwsRevisionIds,
    verifierConfigurationAuthority,
    immutablePackage,
    resolvedS3Object,
    retainedRuntimeFunction,
    desiredState,
    mutableFunction,
    immutableFunction,
    alias,
    observation,
  };
}
export function createImageSignatureVerifierFixture(
  targetKey: string,
): ReturnType<typeof buildImageSignatureVerifierFixture> {
  return buildImageSignatureVerifierFixture(targetKey);
}
export const {
  target,
  app,
  signing,
  sourceSha,
  retainedSourceSha,
  zipSha256,
  retainedZipSha256,
  codeSha256,
  retainedCodeSha256,
  awsConfigSha256,
  assetManifestSha256,
  trustRootSha256,
  proverImageDigest,
  functionName,
  functionArn,
  aliasAwsRevisionIds,
  verifierConfigurationAuthority,
  immutablePackage,
  resolvedS3Object,
  retainedRuntimeFunction,
  desiredState,
  mutableFunction,
  immutableFunction,
  alias,
  observation,
} = createImageSignatureVerifierFixture('stark-dev/develop');
