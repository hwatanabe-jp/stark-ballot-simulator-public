import { Buffer } from 'node:buffer';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  admitAppImageSignatureVerifierDesiredState,
  bindAppImageSignatureVerifierExpectedVersion,
  selectAppImageSignatureVerifierAction,
} from './app-image-signature-verifier-reconciliation.js';
import { canonicalJsonSha256 } from './internal.js';
import {
  alias,
  aliasAwsRevisionIds,
  codeSha256,
  desiredState,
  functionArn,
  functionName,
  immutableFunction,
  mutableFunction,
  observation,
  proverImageDigest,
  resolvedS3Object,
  retainedRuntimeFunction,
  signing,
  target,
  verifierConfigurationAuthority,
} from './testdata/app-image-signature-verifier-fixture.js';

const expectedFunctionConfigurationSha256 =
  target.accountId === '000000000000'
    ? 'df7270e3fe822e77cccdefa166697313962b7b9aba937e7f307c76b1a0f03d44'
    : '5d5efa33a341cb53ab40049b8f8779c6e170547ce0aa869848b9f8b15c96eb10';

describe('App image-signature verifier reconciliation authority', () => {
  it('requires the full canonical Prover image digest in Lambda configuration authority', () => {
    const fullDigest = structuredClone(desiredState());
    fullDigest.functionConfigurationAuthority.environment.IMAGE_SIGNATURE_VERIFIER_EXPECTED_IMAGE_DIGEST =
      proverImageDigest;
    fullDigest.functionConfigurationSha256 = canonicalJsonSha256(fullDigest.functionConfigurationAuthority);

    expect(admitAppImageSignatureVerifierDesiredState(fullDigest)).toEqual(fullDigest);

    const bareDigest = structuredClone(fullDigest);
    bareDigest.functionConfigurationAuthority.environment.IMAGE_SIGNATURE_VERIFIER_EXPECTED_IMAGE_DIGEST =
      proverImageDigest.slice('sha256:'.length);
    bareDigest.functionConfigurationSha256 = canonicalJsonSha256(bareDigest.functionConfigurationAuthority);

    expect(() => admitAppImageSignatureVerifierDesiredState(bareDigest)).toThrow(/digest|authority/iu);
  });

  it('binds only the highest exact match or the unique next decimal FunctionVersion', () => {
    const candidate: Partial<ReturnType<typeof desiredState>> = { ...desiredState() };
    delete candidate.expectedFunctionVersion;

    expect(bindAppImageSignatureVerifierExpectedVersion(candidate, observation())).toEqual(desiredState());
    expect(
      bindAppImageSignatureVerifierExpectedVersion(
        candidate,
        observation({
          immutableFunctions: {
            items: [...observation().immutableFunctions.items, immutableFunction('42')],
            unreadNextMarker: null,
          },
        }),
      ),
    ).toEqual(desiredState());
  });

  it('rejects a changed selected publication before choosing a reconciliation action', () => {
    const desired = desiredState();
    const completeObservation = observation({
      immutableFunctions: {
        items: [immutableFunction('39', retainedRuntimeFunction()), immutableFunction('42'), immutableFunction('43')],
        unreadNextMarker: null,
      },
    });

    expect(() => selectAppImageSignatureVerifierAction(desired, completeObservation)).toThrow(
      /inventory changed from its expected FunctionVersion/iu,
    );

    const mismatchedConfiguration = { ...verifierConfigurationAuthority(), memory_size_mb: 512 };
    for (const immutable of [
      immutableFunction('42', { codeSha256: Buffer.from('6'.repeat(64), 'hex').toString('base64') }),
      immutableFunction('42', {
        resolvedS3Object: { ...resolvedS3Object(), s3ObjectVersionId: 'different-package-object' },
      }),
      immutableFunction('42', { awsConfigSha256: Buffer.from('5'.repeat(64), 'hex').toString('base64') }),
      immutableFunction('42', {
        functionConfigurationAuthority: mismatchedConfiguration,
        functionConfigurationSha256: canonicalJsonSha256(mismatchedConfiguration),
      }),
      immutableFunction('42', { functionArn: `${functionArn}:43` }),
    ]) {
      expect(() =>
        selectAppImageSignatureVerifierAction(
          desired,
          observation({
            immutableFunctions: {
              items: [immutableFunction('39', retainedRuntimeFunction()), immutable],
              unreadNextMarker: null,
            },
          }),
        ),
      ).toThrow(/observed|version|match|qualified ARN/iu);
    }

    expect(() =>
      selectAppImageSignatureVerifierAction({ ...desired, expectedFunctionVersion: '44' }, completeObservation),
    ).toThrow(/inventory changed from its expected FunctionVersion/iu);
  });

  it('admits absent native hashes and S3 coordinates while retaining exact local authority', () => {
    const candidate: Partial<ReturnType<typeof desiredState>> = { ...desiredState() };
    delete candidate.expectedFunctionVersion;
    const withoutNativeMetadata = observation({
      immutableFunctions: {
        items: [
          immutableFunction('39', {
            ...retainedRuntimeFunction(),
            awsConfigSha256: null,
            resolvedS3Object: null,
          }),
          immutableFunction('42', { awsConfigSha256: null, resolvedS3Object: null }),
        ],
        unreadNextMarker: null,
      },
      mutableFunction: mutableFunction({ awsConfigSha256: null, resolvedS3Object: null }),
    });

    expect(bindAppImageSignatureVerifierExpectedVersion(candidate, withoutNativeMetadata)).toEqual(desiredState());
    expect(selectAppImageSignatureVerifierAction(desiredState(), withoutNativeMetadata)).toMatchObject({
      alias: { functionVersion: '42', name: 'preflight' },
      kind: 'update-alias',
    });
  });

  it('rejects a supplied retained-function native configuration hash mismatch', () => {
    expect(() =>
      selectAppImageSignatureVerifierAction(
        desiredState(),
        observation({
          aliases: { preflight: alias('preflight', '42'), runtime: alias('runtime', '39') },
          immutableFunctions: {
            items: [
              immutableFunction('39', {
                ...retainedRuntimeFunction(),
                awsConfigSha256: Buffer.from('2'.repeat(64), 'hex').toString('base64'),
              }),
              immutableFunction('42'),
            ],
            unreadNextMarker: null,
          },
        }),
      ),
    ).toThrow(/retained runtime function.*mismatched/iu);
  });

  it('rejects a malformed partial native S3-coordinate observation', () => {
    expect(() =>
      selectAppImageSignatureVerifierAction(
        desiredState(),
        observation({
          mutableFunction: mutableFunction({
            resolvedS3Object: { s3Bucket: resolvedS3Object().s3Bucket },
          }),
        }),
      ),
    ).toThrow(/resolved S3 object|shape|key|VersionId/iu);
  });

  it('rejects a selected version invalidated by a concurrent immutable publication', () => {
    const concurrent = immutableFunction('43', {
      codeSha256: Buffer.from('6'.repeat(64), 'hex').toString('base64'),
      resolvedS3Object: { ...resolvedS3Object(), s3ObjectVersionId: 'concurrent-package-object' },
    });
    expect(() =>
      selectAppImageSignatureVerifierAction(
        desiredState(),
        observation({
          immutableFunctions: {
            items: [...observation().immutableFunctions.items, concurrent],
            unreadNextMarker: null,
          },
        }),
      ),
    ).toThrow(/expected FunctionVersion|inventory changed/iu);
  });

  it('admits the exact current Terraform configuration authority and target-bound package source', () => {
    const desired = admitAppImageSignatureVerifierDesiredState(desiredState());

    expectTypeOf(desired.functionConfigurationSha256).toBeString();
    expect(desired).toEqual(desiredState());
    expect(desired['functionConfigurationSha256']).toBe(canonicalJsonSha256(verifierConfigurationAuthority()));
    expect(desired['functionConfigurationSha256']).toBe(expectedFunctionConfigurationSha256);
    expect(Object.isFrozen(desired)).toBe(true);
    expect(Object.isFrozen(desired['functionConfigurationAuthority'])).toBe(true);
    expect(Object.isFrozen(desired['package'])).toBe(true);
  });

  it('keeps desired S3 coordinates and local configuration hashes exact when the native hash was absent', () => {
    const desired = structuredClone(desiredState());
    const retained = desired.aliases.runtime.target.function as unknown as Record<string, unknown>;
    retained['awsConfigSha256'] = null;

    expect(admitAppImageSignatureVerifierDesiredState(desired)).toEqual(desired);

    const missingCoordinates = structuredClone(desired);
    (missingCoordinates.aliases.runtime.target.function as unknown as Record<string, unknown>)['resolvedS3Object'] =
      null;
    expect(() => admitAppImageSignatureVerifierDesiredState(missingCoordinates)).toThrow(
      /resolved S3 object|coordinates|shape/iu,
    );

    const missingLocalHash = structuredClone(desired);
    (missingLocalHash.aliases.runtime.target.function as unknown as Record<string, unknown>)[
      'functionConfigurationSha256'
    ] = null;
    expect(() => admitAppImageSignatureVerifierDesiredState(missingLocalHash)).toThrow(/configuration SHA-256/iu);
  });

  it('rejects detached content bindings, non-exact input, and proxies without reading them', () => {
    const valid = desiredState();
    const detached = [
      { ...valid, sourceSha: 'f'.repeat(40) },
      { ...valid, functionConfigurationSha256: '0'.repeat(64) },
      { ...valid, package: { ...valid.package, codeSha256: Buffer.from('0'.repeat(64), 'hex').toString('base64') } },
      { ...valid, package: { ...valid.package, assetManifestSha256: '0'.repeat(64) } },
      {
        ...valid,
        signatureAuthority: { ...valid.signatureAuthority, signingProfileArn: `${signing.signingProfileArn}-other` },
      },
      { ...valid, unexpected: true },
    ];

    for (const value of detached) {
      expect(() => admitAppImageSignatureVerifierDesiredState(value)).toThrow();
    }

    let reads = 0;
    const proxy = new Proxy(valid, {
      get() {
        reads += 1;
        throw new Error('must not read');
      },
      getOwnPropertyDescriptor() {
        reads += 1;
        throw new Error('must not inspect');
      },
      getPrototypeOf() {
        reads += 1;
        throw new Error('must not inspect');
      },
      ownKeys() {
        reads += 1;
        throw new Error('must not inspect');
      },
    });
    expect(() => admitAppImageSignatureVerifierDesiredState(proxy)).toThrow(/exact|proxy/iu);
    expect(reads).toBe(0);
  });

  it('rejects a verifier execution timeout below the current configuration floor', () => {
    const currentConfiguration = verifierConfigurationAuthority();
    const configurationAuthority = {
      ...currentConfiguration,
      environment: {
        ...currentConfiguration.environment,
        IMAGE_SIGNATURE_VERIFIER_HANDLER_DEADLINE_MS: '10000',
        IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPT_TIMEOUT_MS: '250',
        IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPTS: '1',
        IMAGE_SIGNATURE_VERIFIER_STATUS_RETRY_DELAY_MS: '0',
        IMAGE_SIGNATURE_VERIFIER_TIMEOUT_MS: '1000',
      },
      timeout_seconds: 29,
    };
    const desired = {
      ...desiredState(),
      functionConfigurationAuthority: configurationAuthority,
      functionConfigurationSha256: canonicalJsonSha256(configurationAuthority),
    };

    expect(() => admitAppImageSignatureVerifierDesiredState(desired)).toThrow(/timeout/iu);
  });

  it('routes architecture drift through the package update while other configuration drift remains separate', () => {
    const architectureDrift = { ...verifierConfigurationAuthority(), architectures: ['arm64'] };
    expect(
      selectAppImageSignatureVerifierAction(
        desiredState(),
        observation({
          mutableFunction: mutableFunction({
            functionConfigurationAuthority: architectureDrift,
            functionConfigurationSha256: canonicalJsonSha256(architectureDrift),
          }),
        }),
      ),
    ).toEqual({
      architectures: ['x86_64'],
      expectedAwsRevisionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      functionName,
      kind: 'update-function-code',
      package: desiredState().package,
      publish: false,
    });

    const combinedDrift = { ...architectureDrift, memory_size_mb: 512 };
    const configurationAction = selectAppImageSignatureVerifierAction(
      desiredState(),
      observation({
        mutableFunction: mutableFunction({
          functionConfigurationAuthority: combinedDrift,
          functionConfigurationSha256: canonicalJsonSha256(combinedDrift),
        }),
      }),
    );
    const functionConfiguration: Record<string, unknown> = { ...verifierConfigurationAuthority() };
    delete functionConfiguration['architectures'];
    delete functionConfiguration['package_type'];
    expect(configurationAction).toEqual({
      description: '',
      expectedAwsRevisionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      functionConfiguration,
      functionName,
      kind: 'update-function-configuration',
    });

    const immutablePackageType = { ...verifierConfigurationAuthority(), package_type: 'Image' };
    expect(() =>
      selectAppImageSignatureVerifierAction(
        desiredState(),
        observation({
          mutableFunction: mutableFunction({
            functionConfigurationAuthority: immutablePackageType,
            functionConfigurationSha256: canonicalJsonSha256(immutablePackageType),
          }),
        }),
      ),
    ).toThrow(/package type.*reconcil/iu);
  });

  it('selects conditional configuration and package updates before immutable publication', () => {
    const wrongConfiguration = { ...verifierConfigurationAuthority(), memory_size_mb: 512 };
    expect(
      selectAppImageSignatureVerifierAction(
        desiredState(),
        observation({
          mutableFunction: mutableFunction({
            codeSha256: Buffer.from('0'.repeat(64), 'hex').toString('base64'),
            functionConfigurationAuthority: wrongConfiguration,
            functionConfigurationSha256: canonicalJsonSha256(wrongConfiguration),
          }),
        }),
      ),
    ).toMatchObject({
      expectedAwsRevisionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      kind: 'update-function-configuration',
    });

    expect(
      selectAppImageSignatureVerifierAction(
        desiredState(),
        observation({
          mutableFunction: mutableFunction({
            codeSha256: Buffer.from('0'.repeat(64), 'hex').toString('base64'),
            resolvedS3Object: {
              ...resolvedS3Object(),
              s3ObjectVersionId: 'different-package-object',
            },
          }),
        }),
      ),
    ).toEqual({
      architectures: ['x86_64'],
      expectedAwsRevisionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      functionName,
      kind: 'update-function-code',
      package: desiredState().package,
      publish: false,
    });

    expect(selectAppImageSignatureVerifierAction(desiredState(), observation())).toEqual({
      codeSha256,
      expectedAwsRevisionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      expectedFunctionVersion: '42',
      functionName,
      kind: 'publish-immutable-function',
    });

    expect(
      selectAppImageSignatureVerifierAction(
        desiredState(),
        observation({ mutableFunction: mutableFunction({ description: 'out-of-band description' }) }),
      ),
    ).toMatchObject({ description: '', kind: 'update-function-configuration' });
  });

  it('reuses only the numerically highest exact qualified publication without trusting service order', () => {
    const hugeFunctionVersion = '999999999999999999999999999999999999999999';
    const items = [
      immutableFunction('42'),
      immutableFunction('41'),
      immutableFunction(hugeFunctionVersion),
      immutableFunction('39', retainedRuntimeFunction()),
    ];
    const action = selectAppImageSignatureVerifierAction(
      { ...desiredState(), expectedFunctionVersion: hugeFunctionVersion },
      observation({ immutableFunctions: { items, unreadNextMarker: null } }),
    );

    expectTypeOf(action.kind).toEqualTypeOf<
      | 'publish-immutable-function'
      | 'update-alias'
      | 'update-function-code'
      | 'update-function-configuration'
      | 'validate-live-state'
      | 'wait-for-function-readiness'
    >();
    expect(action).toEqual({
      alias: {
        aliasArn: `${functionArn}:preflight`,
        description: 'Qualified non-accepting cryptographic verifier preflight',
        functionVersion: hugeFunctionVersion,
        name: 'preflight',
      },
      expectedAwsRevisionId: aliasAwsRevisionIds.preflight,
      functionName,
      kind: 'update-alias',
    });
  });

  it('publishes when only an older qualified publication matches the exact source and configuration', () => {
    const items = [
      immutableFunction('42', {
        codeSha256: Buffer.from('0'.repeat(64), 'hex').toString('base64'),
        resolvedS3Object: { ...resolvedS3Object(), s3ObjectVersionId: 'different-package-object' },
      }),
      immutableFunction('41'),
      immutableFunction('39', retainedRuntimeFunction()),
    ];

    expect(
      selectAppImageSignatureVerifierAction(
        { ...desiredState(), expectedFunctionVersion: '43' },
        observation({ immutableFunctions: { items, unreadNextMarker: null } }),
      ),
    ).toMatchObject({ kind: 'publish-immutable-function' });
  });

  it('advances preflight independently while preserving exact retained runtime authority', () => {
    const immutableFunctions = {
      items: [immutableFunction('42'), immutableFunction('39', retainedRuntimeFunction())],
      unreadNextMarker: null,
    };

    expect(selectAppImageSignatureVerifierAction(desiredState(), observation({ immutableFunctions }))).toMatchObject({
      alias: { functionVersion: '42', name: 'preflight' },
      kind: 'update-alias',
    });

    expect(
      selectAppImageSignatureVerifierAction(
        desiredState(),
        observation({
          aliases: { preflight: alias('preflight', '42'), runtime: alias('runtime', '39') },
          immutableFunctions,
        }),
      ),
    ).toEqual({
      aliases: { preflight: alias('preflight', '42'), runtime: alias('runtime', '39') },
      kind: 'validate-live-state',
      runtimeFunction: immutableFunction('39', retainedRuntimeFunction()),
      selectedFunction: immutableFunction('42'),
    });

    expect(() =>
      selectAppImageSignatureVerifierAction(
        desiredState(),
        observation({
          aliases: { preflight: alias('preflight', '42'), runtime: alias('runtime', '42') },
          immutableFunctions,
        }),
      ),
    ).toThrow(/retained runtime/iu);
  });

  it('waits for an in-progress function and rejects failed, incomplete, duplicate, or weighted observations', () => {
    expect(
      selectAppImageSignatureVerifierAction(
        desiredState(),
        observation({ mutableFunction: mutableFunction({ lastUpdateStatus: 'InProgress' }) }),
      ),
    ).toEqual({ functionName, kind: 'wait-for-function-readiness' });

    expect(() =>
      selectAppImageSignatureVerifierAction(
        desiredState(),
        observation({ mutableFunction: mutableFunction({ lastUpdateStatus: 'Failed' }) }),
      ),
    ).toThrow(/failed/iu);
    expect(() =>
      selectAppImageSignatureVerifierAction(
        desiredState(),
        observation({
          mutableFunction: mutableFunction({ lastUpdateStatus: 'InProgress', state: 'Failed' }),
        }),
      ),
    ).toThrow(/failed/iu);
    expect(() =>
      selectAppImageSignatureVerifierAction(
        desiredState(),
        observation({ immutableFunctions: { items: [], unreadNextMarker: 'service-marker' } }),
      ),
    ).toThrow(/complete/iu);
    expect(() =>
      selectAppImageSignatureVerifierAction(
        desiredState(),
        observation({
          immutableFunctions: {
            items: [
              immutableFunction('42'),
              immutableFunction('42'),
              immutableFunction('39', retainedRuntimeFunction()),
            ],
            unreadNextMarker: null,
          },
        }),
      ),
    ).toThrow(/duplicate/iu);
    expect(() =>
      selectAppImageSignatureVerifierAction(
        desiredState(),
        observation({
          aliases: {
            preflight: { ...alias('preflight', '39'), routingWeights: { '41': 0.1 } },
            runtime: alias('runtime', '39'),
          },
        }),
      ),
    ).toThrow(/routing/iu);
  });

  it('rejects missing aliases and look-alike qualified publications', () => {
    expect(() =>
      selectAppImageSignatureVerifierAction(
        desiredState(),
        observation({ aliases: { preflight: null, runtime: alias('runtime', '39') } }),
      ),
    ).toThrow(/preflight alias.*missing/iu);

    for (const detached of [
      { resolvedS3Object: { ...resolvedS3Object(), s3Key: 'lambda-artifacts/other/image-signature-verifier.zip' } },
      { description: 'source marker' },
      { awsConfigSha256: Buffer.from('2'.repeat(64), 'hex').toString('base64') },
    ]) {
      const items = [immutableFunction('42', detached), immutableFunction('39', retainedRuntimeFunction())];
      expect(
        selectAppImageSignatureVerifierAction(
          { ...desiredState(), expectedFunctionVersion: '43' },
          observation({ immutableFunctions: { items, unreadNextMarker: null } }),
        ),
      ).toMatchObject({ kind: 'publish-immutable-function' });
    }

    expect(() =>
      selectAppImageSignatureVerifierAction(
        desiredState(),
        observation({
          immutableFunctions: {
            items: [
              immutableFunction('42', { functionArn: `${functionArn}:43` }),
              immutableFunction('39', retainedRuntimeFunction()),
            ],
            unreadNextMarker: null,
          },
        }),
      ),
    ).toThrow(/qualified ARN/iu);
  });

  it('binds retained runtime authority to the same target, package family, and signing identity', () => {
    const detached = [
      (value: ReturnType<typeof desiredState>) => {
        value.aliases.runtime.target.function.resolvedS3Object.s3Bucket = 'other-bucket';
      },
      (value: ReturnType<typeof desiredState>) => {
        value.aliases.runtime.target.function.resolvedS3Object.s3Key =
          'lambda-artifacts/not-a-source/image-signature-verifier.zip';
      },
      (value: ReturnType<typeof desiredState>) => {
        value.aliases.runtime.target.function.functionConfigurationAuthority.role_arn += '-other';
        value.aliases.runtime.target.function.functionConfigurationSha256 = canonicalJsonSha256(
          value.aliases.runtime.target.function.functionConfigurationAuthority,
        );
      },
      (value: ReturnType<typeof desiredState>) => {
        value.aliases.runtime.target.function.functionConfigurationAuthority.environment.IMAGE_SIGNATURE_VERIFIER_EXPECTED_SIGNING_PROFILE_ARN +=
          '-other';
        value.aliases.runtime.target.function.functionConfigurationSha256 = canonicalJsonSha256(
          value.aliases.runtime.target.function.functionConfigurationAuthority,
        );
      },
    ];

    for (const mutate of detached) {
      const value = structuredClone(desiredState());
      mutate(value);
      expect(() => admitAppImageSignatureVerifierDesiredState(value)).toThrow(/retained|target|package|signing/iu);
    }
  });

  it('rejects a nested observation proxy without invoking its traps', () => {
    let traps = 0;
    const aliases = new Proxy(observation().aliases, {
      get() {
        traps += 1;
        throw new Error('must not read');
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error('must not inspect');
      },
      getPrototypeOf() {
        traps += 1;
        throw new Error('must not inspect');
      },
      ownKeys() {
        traps += 1;
        throw new Error('must not inspect');
      },
    });

    expect(() => selectAppImageSignatureVerifierAction(desiredState(), { ...observation(), aliases })).toThrow(
      /proxy/iu,
    );
    expect(traps).toBe(0);
  });

  it('rejects an over-bound inventory before inspecting any item', () => {
    let itemTraps = 0;
    const item = new Proxy(
      {},
      {
        get() {
          itemTraps += 1;
          throw new Error('must not read');
        },
        getOwnPropertyDescriptor() {
          itemTraps += 1;
          throw new Error('must not inspect');
        },
        getPrototypeOf() {
          itemTraps += 1;
          throw new Error('must not inspect');
        },
        ownKeys() {
          itemTraps += 1;
          throw new Error('must not inspect');
        },
      },
    );
    const items = Array.from({ length: 65 }, () => item);

    expect(() =>
      selectAppImageSignatureVerifierAction(
        desiredState(),
        observation({ immutableFunctions: { items, unreadNextMarker: null } }),
      ),
    ).toThrow(/bound/iu);
    expect(itemTraps).toBe(0);
  });
});
