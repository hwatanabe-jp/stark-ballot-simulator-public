import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ecrSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-ecr', () => {
  class MockEcrClient {
    send = ecrSend;
  }

  class MockDescribeImageSigningStatusCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  return {
    ECRClient: MockEcrClient,
    DescribeImageSigningStatusCommand: MockDescribeImageSigningStatusCommand,
  };
});

const { createEcrSigningStatusLookup, createImageSignatureVerifierHandler } = await import('./index.mjs');

const imageDigest = `sha256:${'1'.repeat(64)}`;
const invocation = {
  imageUri: `123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/stark-ballot/prover@${imageDigest}`,
  registryId: '123456789012',
  imageRegion: 'ap-northeast-1',
  repositoryName: 'stark-ballot/prover',
  imageDigest,
  signingProfileArn: 'arn:aws:signer:ap-northeast-1:123456789012:/signing-profiles/stark_ballot_image_signing',
};
const environment = {
  IMAGE_SIGNATURE_VERIFIER_EXPECTED_REGISTRY_ID: invocation.registryId,
  IMAGE_SIGNATURE_VERIFIER_EXPECTED_REGION: invocation.imageRegion,
  IMAGE_SIGNATURE_VERIFIER_EXPECTED_REPOSITORY_NAME: invocation.repositoryName,
  IMAGE_SIGNATURE_VERIFIER_EXPECTED_IMAGE_DIGEST: invocation.imageDigest,
  IMAGE_SIGNATURE_VERIFIER_EXPECTED_SIGNING_PROFILE_ARN: invocation.signingProfileArn,
  IMAGE_SIGNATURE_VERIFIER_EXPECTED_ASSET_MANIFEST_SHA256: 'a'.repeat(64),
  IMAGE_SIGNATURE_VERIFIER_EXPECTED_TRUST_ROOT_SHA256: 'b'.repeat(64),
  IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPTS: '3',
  IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPT_TIMEOUT_MS: '1000',
  IMAGE_SIGNATURE_VERIFIER_STATUS_RETRY_DELAY_MS: '250',
  IMAGE_SIGNATURE_VERIFIER_TIMEOUT_MS: '19000',
  IMAGE_SIGNATURE_VERIFIER_HANDLER_DEADLINE_MS: '30000',
  AWS_ACCESS_KEY_ID: 'lambda-access-key',
  AWS_SECRET_ACCESS_KEY: 'lambda-secret-key',
  AWS_SESSION_TOKEN: 'lambda-session-token',
  LOG_IP_HASH_SALT_REF: 'must-not-be-read-or-logged',
  VOTE_SECRET_ENCRYPTION_KEY: 'must-not-be-read-or-logged',
};
const verifiedResult = {
  result: 'VERIFIED' as const,
  mode: 'cryptographic' as const,
  verifierVersion: 'notation@1.3.2+aws-signer-plugin@1.0.2292',
  verifierAssets: {
    notationVersion: '1.3.2' as const,
    awsSignerPluginVersion: '1.0.2292' as const,
    ecrCredentialHelperVersion: '0.12.0' as const,
    trustRootSha256: environment.IMAGE_SIGNATURE_VERIFIER_EXPECTED_TRUST_ROOT_SHA256,
  },
  assetManifestSha256: environment.IMAGE_SIGNATURE_VERIFIER_EXPECTED_ASSET_MANIFEST_SHA256,
  trustPolicySha256: 'c'.repeat(64),
};

describe('target cryptographic image signature verifier Lambda', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is source-level independent from shared runtime references and secret-bearing observability', async () => {
    const source = await readFile(path.join(process.cwd(), 'infra/lambdas/image-signature-verifier/index.mjs'), 'utf8');
    expect(source).not.toContain('ensureAwsRuntimeConfigReferencesLoaded');
    expect(source).not.toContain('validateTargetObservabilityEnv');
    expect(source).not.toContain('@stark-ballot/runtime-config');
    expect(source).not.toContain('@stark-ballot/diagnostics');
  });

  it('cross-checks exact configured image authority and returns bounded cryptographic evidence', async () => {
    const verify = vi.fn(async () => await Promise.resolve(verifiedResult));
    const logs: Array<Record<string, unknown>> = [];
    const handler = createImageSignatureVerifierHandler({
      environment,
      assetRoot: '/var/task/image-signature-verifier',
      temporaryRoot: '/tmp',
      verify,
      describeSigningStatus: async () => await Promise.resolve([]),
      now: (() => {
        const times = [1_000, 1_140];
        return () => times.shift() ?? 1_140;
      })(),
      log: (record: Record<string, unknown>) => logs.push(record),
    });

    await expect(
      handler(invocation, {
        awsRequestId: 'safe-request-id',
        getRemainingTimeInMillis: () => 120_000,
      }),
    ).resolves.toEqual({
      result: 'VERIFIED',
      mode: 'cryptographic',
      verifierVersion: 'notation@1.3.2+aws-signer-plugin@1.0.2292',
      trustPolicySha256: 'c'.repeat(64),
    });
    expect(verify).toHaveBeenCalledWith(
      invocation,
      expect.objectContaining({
        assetRoot: '/var/task/image-signature-verifier',
        temporaryRoot: '/tmp',
        expectedArchitecture: 'amd64',
        sourceEnvironment: environment,
        maxStatusAttempts: 3,
        statusAttemptTimeoutMs: 1_000,
        statusRetryDelayMs: 250,
        verifierTimeoutMs: 19_000,
        expectedAssetManifestSha256: environment.IMAGE_SIGNATURE_VERIFIER_EXPECTED_ASSET_MANIFEST_SHA256,
        expectedTrustRootSha256: environment.IMAGE_SIGNATURE_VERIFIER_EXPECTED_TRUST_ROOT_SHA256,
      }),
    );
    expect(logs).toEqual([
      {
        service: 'image-signature-verifier',
        event: 'verification_started',
        requestId: 'safe-request-id',
      },
      {
        service: 'image-signature-verifier',
        event: 'verification_completed',
        result: 'VERIFIED',
        durationBucket: 'under_250ms',
        requestId: 'safe-request-id',
      },
    ]);
    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain(imageDigest);
    expect(serializedLogs).not.toContain(invocation.signingProfileArn);
    expect(serializedLogs).not.toContain(environment.AWS_SECRET_ACCESS_KEY);
    expect(serializedLogs).not.toContain(environment.LOG_IP_HASH_SALT_REF);
  });

  it('passes one object to the Lambda native JSON logger by default', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const handler = createImageSignatureVerifierHandler({
        environment,
        assetRoot: '/var/task/image-signature-verifier',
        temporaryRoot: '/tmp',
        verify: vi.fn(async () => await Promise.resolve(verifiedResult)),
        describeSigningStatus: async () => await Promise.resolve([]),
        now: () => 1_000,
      });

      await expect(handler(invocation, { awsRequestId: 'safe-request-id' })).resolves.toMatchObject({
        result: 'VERIFIED',
      });

      expect(logSpy).toHaveBeenCalled();
      for (const call of logSpy.mock.calls) {
        expect(call).toHaveLength(1);
        expect(call[0]).toEqual(expect.objectContaining({ service: 'image-signature-verifier' }));
        expect(typeof call[0]).toBe('object');
      }
    } finally {
      logSpy.mockRestore();
    }
  });

  it('logs a bounded internal diagnostic without changing the public rejection contract', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const handler = createImageSignatureVerifierHandler({
      environment,
      assetRoot: '/var/task/image-signature-verifier',
      temporaryRoot: '/tmp',
      verify: vi.fn(
        async () =>
          await Promise.resolve({
            result: 'VERIFIER_ERROR',
            mode: 'cryptographic',
            reasonCode: 'ASSET_FILE_MODE_INVALID',
          } as const),
      ),
      describeSigningStatus: async () => await Promise.resolve([]),
      now: (() => {
        const times = [2_000, 2_211];
        return () => times.shift() ?? 2_211;
      })(),
      log: (record: Record<string, unknown>) => logs.push(record),
    });

    await expect(handler(invocation, { awsRequestId: 'bounded-diagnostic-id' })).resolves.toEqual({
      result: 'REJECTED',
      mode: 'cryptographic',
      reasonCode: 'VERIFIER_ERROR',
    });
    expect(logs).toEqual([
      {
        service: 'image-signature-verifier',
        event: 'verification_started',
        requestId: 'bounded-diagnostic-id',
      },
      {
        service: 'image-signature-verifier',
        event: 'verification_completed',
        result: 'REJECTED',
        internalReasonCode: 'ASSET_FILE_MODE_INVALID',
        durationBucket: 'under_250ms',
        requestId: 'bounded-diagnostic-id',
      },
    ]);
    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain(imageDigest);
    expect(serializedLogs).not.toContain(invocation.signingProfileArn);
    expect(serializedLogs).not.toContain(environment.AWS_SECRET_ACCESS_KEY);
    expect(serializedLogs).not.toContain(environment.VOTE_SECRET_ENCRYPTION_KEY);

    const unknownReasonLogs: Array<Record<string, unknown>> = [];
    const unknownReasonHandler = createImageSignatureVerifierHandler({
      environment,
      assetRoot: '/var/task/image-signature-verifier',
      temporaryRoot: '/tmp',
      verify: vi.fn(
        async () =>
          await Promise.resolve({
            result: 'VERIFIER_ERROR',
            mode: 'cryptographic',
            reasonCode: 'PRIVATE_SECRET_CODE',
          } as const),
      ),
      describeSigningStatus: async () => await Promise.resolve([]),
      log: (record: Record<string, unknown>) => unknownReasonLogs.push(record),
    });

    await expect(unknownReasonHandler(invocation, {})).resolves.toEqual({
      result: 'REJECTED',
      mode: 'cryptographic',
      reasonCode: 'VERIFIER_ERROR',
    });
    expect(unknownReasonLogs.at(-1)).toMatchObject({
      event: 'verification_completed',
      internalReasonCode: 'VERIFIER_REASON_INVALID',
    });
    expect(JSON.stringify(unknownReasonLogs)).not.toContain('PRIVATE_SECRET_CODE');
  });

  it('rejects event/config/package authority drift without invoking Notation', async () => {
    const verify = vi.fn(
      async () =>
        await Promise.resolve({
          ...verifiedResult,
          assetManifestSha256: 'd'.repeat(64),
        }),
    );
    const handler = createImageSignatureVerifierHandler({
      environment,
      assetRoot: '/var/task/image-signature-verifier',
      temporaryRoot: '/tmp',
      verify,
      describeSigningStatus: async () => await Promise.resolve([]),
      log: () => undefined,
    });

    await expect(handler({ ...invocation, imageDigest: `sha256:${'2'.repeat(64)}` }, {})).resolves.toEqual({
      result: 'REJECTED',
      mode: 'cryptographic',
      reasonCode: 'VERIFICATION_FAILED',
    });
    expect(verify).not.toHaveBeenCalled();

    await expect(handler(invocation, {})).resolves.toEqual({
      result: 'REJECTED',
      mode: 'cryptographic',
      reasonCode: 'VERIFIER_ERROR',
    });
    expect(verify).toHaveBeenCalledOnce();

    const invalidConfigHandler = createImageSignatureVerifierHandler({
      environment: { ...environment, IMAGE_SIGNATURE_VERIFIER_TIMEOUT_MS: 'unbounded' },
      assetRoot: '/var/task/image-signature-verifier',
      temporaryRoot: '/tmp',
      verify,
      describeSigningStatus: async () => await Promise.resolve([]),
      log: () => undefined,
    });
    await expect(invalidConfigHandler(invocation, {})).resolves.toEqual({
      result: 'REJECTED',
      mode: 'cryptographic',
      reasonCode: 'VERIFIER_ERROR',
    });
    expect(verify).toHaveBeenCalledOnce();
  });

  it('normalizes every internal failure to the exact documented rejection union', async () => {
    const results = [
      {
        internal: {
          result: 'VERIFICATION_FAILED',
          mode: 'cryptographic',
          reasonCode: 'SIGNING_NOT_READY',
        },
        expected: 'SIGNING_NOT_READY',
      },
      {
        internal: {
          result: 'VERIFICATION_FAILED',
          mode: 'cryptographic',
          reasonCode: 'SIGNING_FAILED',
        },
        expected: 'SIGNING_FAILED',
      },
      {
        internal: {
          result: 'VERIFICATION_FAILED',
          mode: 'cryptographic',
          reasonCode: 'EXPECTED_PROFILE_MISSING',
        },
        expected: 'EXPECTED_PROFILE_MISSING',
      },
      {
        internal: {
          result: 'VERIFIER_ERROR',
          mode: 'cryptographic',
          reasonCode: 'EXPECTED_PROFILE_AMBIGUOUS',
        },
        expected: 'EXPECTED_PROFILE_AMBIGUOUS',
      },
      {
        internal: {
          result: 'VERIFIER_ERROR',
          mode: 'cryptographic',
          reasonCode: 'UNEXPECTED_PROFILE',
        },
        expected: 'UNEXPECTED_PROFILE',
      },
      {
        internal: {
          result: 'VERIFICATION_FAILED',
          mode: 'cryptographic',
          reasonCode: 'CRYPTOGRAPHIC_VERIFICATION_FAILED',
        },
        expected: 'VERIFICATION_FAILED',
      },
      {
        internal: {
          result: 'VERIFIER_TIMEOUT',
          mode: 'cryptographic',
          reasonCode: 'CRYPTOGRAPHIC_VERIFIER_TIMEOUT',
        },
        expected: 'VERIFIER_TIMEOUT',
      },
      {
        internal: {
          result: 'VERIFIER_ERROR',
          mode: 'cryptographic',
          reasonCode: 'ASSET_CONTRACT_INVALID',
        },
        expected: 'VERIFIER_ERROR',
      },
    ] as const;

    for (const result of results) {
      const handler = createImageSignatureVerifierHandler({
        environment,
        assetRoot: '/var/task/image-signature-verifier',
        temporaryRoot: '/tmp',
        verify: vi.fn(async () => await Promise.resolve(result.internal)),
        describeSigningStatus: async () => await Promise.resolve([]),
        log: () => undefined,
      });

      await expect(handler(invocation, {})).resolves.toEqual({
        result: 'REJECTED',
        mode: 'cryptographic',
        reasonCode: result.expected,
      });
    }
  });

  it('fails configuration closed when the declared soft-deadline budget cannot contain all work', async () => {
    const verify = vi.fn(async () => await Promise.resolve(verifiedResult));
    const handler = createImageSignatureVerifierHandler({
      environment: {
        ...environment,
        IMAGE_SIGNATURE_VERIFIER_HANDLER_DEADLINE_MS: '24000',
      },
      assetRoot: '/var/task/image-signature-verifier',
      temporaryRoot: '/tmp',
      verify,
      describeSigningStatus: async () => await Promise.resolve([]),
      log: () => undefined,
    });

    await expect(handler(invocation, {})).resolves.toEqual({
      result: 'REJECTED',
      mode: 'cryptographic',
      reasonCode: 'VERIFIER_ERROR',
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('accepts exact timeout upper bounds and rejects values one millisecond above them', async () => {
    const upperBoundEnvironment = {
      ...environment,
      IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPTS: '4',
      IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPT_TIMEOUT_MS: '4000',
      IMAGE_SIGNATURE_VERIFIER_STATUS_RETRY_DELAY_MS: '5000',
      IMAGE_SIGNATURE_VERIFIER_TIMEOUT_MS: '60000',
      IMAGE_SIGNATURE_VERIFIER_HANDLER_DEADLINE_MS: '120000',
    };
    const verifyAtBoundary = vi.fn(async () => await Promise.resolve(verifiedResult));
    const boundaryHandler = createImageSignatureVerifierHandler({
      environment: upperBoundEnvironment,
      assetRoot: '/var/task/image-signature-verifier',
      temporaryRoot: '/tmp',
      verify: verifyAtBoundary,
      describeSigningStatus: async () => await Promise.resolve([]),
      log: () => undefined,
    });

    await expect(boundaryHandler(invocation, {})).resolves.toMatchObject({
      result: 'VERIFIED',
      mode: 'cryptographic',
    });
    expect(verifyAtBoundary).toHaveBeenCalledOnce();

    const invalidUpperBounds = [
      ['IMAGE_SIGNATURE_VERIFIER_STATUS_RETRY_DELAY_MS', '5001'],
      ['IMAGE_SIGNATURE_VERIFIER_TIMEOUT_MS', '60001'],
      ['IMAGE_SIGNATURE_VERIFIER_HANDLER_DEADLINE_MS', '120001'],
    ] as const;
    for (const [name, value] of invalidUpperBounds) {
      const verifyAboveBoundary = vi.fn(async () => await Promise.resolve(verifiedResult));
      const invalidHandler = createImageSignatureVerifierHandler({
        environment: {
          ...upperBoundEnvironment,
          [name]: value,
        },
        assetRoot: '/var/task/image-signature-verifier',
        temporaryRoot: '/tmp',
        verify: verifyAboveBoundary,
        describeSigningStatus: async () => await Promise.resolve([]),
        log: () => undefined,
      });

      await expect(invalidHandler(invocation, {})).resolves.toEqual({
        result: 'REJECTED',
        mode: 'cryptographic',
        reasonCode: 'VERIFIER_ERROR',
      });
      expect(verifyAboveBoundary).not.toHaveBeenCalled();
    }
  });

  it('looks up only the exact registry, repository, and digest for readiness', async () => {
    ecrSend.mockResolvedValueOnce({
      signingStatuses: [
        {
          signingProfileArn: invocation.signingProfileArn,
          status: 'COMPLETE',
        },
      ],
    });

    const lookup = createEcrSigningStatusLookup();
    const abortSignal = new AbortController().signal;
    await expect(lookup(invocation, abortSignal)).resolves.toEqual([
      {
        signingProfileArn: invocation.signingProfileArn,
        status: 'COMPLETE',
      },
    ]);
    expect(ecrSend).toHaveBeenCalledOnce();
    expect(ecrSend.mock.calls[0]?.[0]).toMatchObject({
      input: {
        registryId: invocation.registryId,
        repositoryName: invocation.repositoryName,
        imageId: { imageDigest: invocation.imageDigest },
      },
    });
    expect(ecrSend.mock.calls[0]?.[1]).toEqual({
      abortSignal,
    });
  });
});
