import { describe, expect, it } from 'vitest';
import {
  buildVerifierEnvironment,
  inspectSigningStatuses,
  parseImageSignatureInvocation,
  pollSigningReadiness,
  selectAwsCredentialEnvironment,
} from './verifier.mjs';

const imageDigest = `sha256:${'1'.repeat(64)}`;
const validInvocation = {
  imageUri: `123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/stark-ballot/prover@${imageDigest}`,
  registryId: '123456789012',
  imageRegion: 'ap-northeast-1',
  repositoryName: 'stark-ballot/prover',
  imageDigest,
  signingProfileArn: 'arn:aws:signer:ap-northeast-1:123456789012:/signing-profiles/stark_ballot_image_signing',
};

describe('cryptographic image verifier invocation', () => {
  it('accepts only an exact digest URI and same-account, same-region signing profile', () => {
    expect(parseImageSignatureInvocation(validInvocation)).toEqual(validInvocation);

    for (const invalid of [
      { ...validInvocation, imageUri: `${validInvocation.imageUri}:latest` },
      { ...validInvocation, repositoryName: '../prover' },
      {
        ...validInvocation,
        signingProfileArn: 'arn:aws:signer:us-east-1:123456789012:/signing-profiles/stark_ballot_image_signing',
      },
      {
        ...validInvocation,
        signingProfileArn: 'arn:aws:signer:ap-northeast-1:999999999999:/signing-profiles/stark_ballot_image_signing',
      },
      { ...validInvocation, unexpected: 'field' },
    ]) {
      expect(parseImageSignatureInvocation(invalid)).toBeUndefined();
    }
  });
});

describe('managed-signing readiness diagnostics', () => {
  it('selects exactly one expected COMPLETE profile independently of list order', () => {
    expect(
      inspectSigningStatuses(
        [{ status: 'COMPLETE', signingProfileArn: validInvocation.signingProfileArn }],
        validInvocation.signingProfileArn,
      ),
    ).toEqual({ kind: 'ready' });

    expect(
      inspectSigningStatuses(
        [
          { status: 'COMPLETE', signingProfileArn: validInvocation.signingProfileArn },
          {
            status: 'IN_PROGRESS',
            signingProfileArn: 'arn:aws:signer:ap-northeast-1:123456789012:/signing-profiles/unexpected_profile',
          },
        ],
        validInvocation.signingProfileArn,
      ),
    ).toEqual({ kind: 'error', reasonCode: 'UNEXPECTED_PROFILE' });
  });

  it('fails closed on malformed, ambiguous, failed, and unknown status sets', () => {
    const expectedArn = validInvocation.signingProfileArn;
    expect(inspectSigningStatuses(undefined, expectedArn)).toEqual({
      kind: 'error',
      reasonCode: 'MALFORMED_SIGNING_STATUS',
    });
    expect(inspectSigningStatuses([{}], expectedArn)).toEqual({
      kind: 'error',
      reasonCode: 'MALFORMED_SIGNING_STATUS',
    });
    for (const signingProfileArn of ['', 'not-an-arn']) {
      expect(inspectSigningStatuses([{ signingProfileArn, status: 'COMPLETE' }], expectedArn)).toEqual({
        kind: 'error',
        reasonCode: 'MALFORMED_SIGNING_STATUS',
      });
    }
    expect(inspectSigningStatuses([{ signingProfileArn: expectedArn, status: 'UNKNOWN' }], expectedArn)).toEqual({
      kind: 'error',
      reasonCode: 'MALFORMED_SIGNING_STATUS',
    });
    expect(
      inspectSigningStatuses(
        [
          { signingProfileArn: expectedArn, status: 'COMPLETE' },
          { signingProfileArn: expectedArn, status: 'COMPLETE' },
        ],
        expectedArn,
      ),
    ).toEqual({ kind: 'error', reasonCode: 'EXPECTED_PROFILE_AMBIGUOUS' });
    expect(inspectSigningStatuses([{ signingProfileArn: expectedArn, status: 'FAILED' }], expectedArn)).toEqual({
      kind: 'failed',
      reasonCode: 'SIGNING_FAILED',
    });
  });

  it('retries only empty and expected-profile IN_PROGRESS results within a fixed budget', async () => {
    const responses = [
      [],
      [{ signingProfileArn: validInvocation.signingProfileArn, status: 'IN_PROGRESS' }],
      [{ signingProfileArn: validInvocation.signingProfileArn, status: 'COMPLETE' }],
    ];
    const delays: number[] = [];

    await expect(
      pollSigningReadiness(validInvocation, {
        maxAttempts: 3,
        attemptTimeoutMs: 1_000,
        retryDelayMs: 17,
        describeSigningStatus: async () => await Promise.resolve(responses.shift()),
        sleep: async (delayMs: number) => {
          await Promise.resolve();
          delays.push(delayMs);
        },
      }),
    ).resolves.toEqual({ kind: 'ready' });
    expect(delays).toEqual([17, 17]);
  });

  it('returns bounded terminal diagnostics without exposing service failure text', async () => {
    await expect(
      pollSigningReadiness(validInvocation, {
        maxAttempts: 2,
        attemptTimeoutMs: 1_000,
        retryDelayMs: 1,
        describeSigningStatus: async () =>
          await Promise.resolve([
            {
              signingProfileArn: validInvocation.signingProfileArn,
              status: 'IN_PROGRESS',
              failureReason: 'token=never-return-this',
            },
          ]),
        sleep: async () => await Promise.resolve(undefined),
      }),
    ).resolves.toEqual({ kind: 'failed', reasonCode: 'SIGNING_NOT_READY' });

    await expect(
      pollSigningReadiness(validInvocation, {
        maxAttempts: 2,
        attemptTimeoutMs: 1_000,
        retryDelayMs: 1,
        describeSigningStatus: async () => {
          await Promise.resolve();
          throw new Error('private registry path must not escape');
        },
        sleep: async () => await Promise.resolve(undefined),
      }),
    ).resolves.toEqual({ kind: 'error', reasonCode: 'SIGNING_STATUS_LOOKUP_ERROR' });
  });

  it('aborts and bounds a hung signing-status SDK attempt', async () => {
    let observedSignal: AbortSignal | undefined;
    await expect(
      pollSigningReadiness(validInvocation, {
        maxAttempts: 1,
        attemptTimeoutMs: 1,
        retryDelayMs: 0,
        describeSigningStatus: async (_invocation, abortSignal) => {
          observedSignal = abortSignal;
          await new Promise(() => undefined);
        },
      }),
    ).resolves.toEqual({ kind: 'error', reasonCode: 'SIGNING_STATUS_LOOKUP_ERROR' });
    expect(observedSignal?.aborted).toBe(true);
  });
});

describe('verifier subprocess environment', () => {
  it('forwards exactly one complete Lambda session-credential source', () => {
    const source = {
      AWS_ACCESS_KEY_ID: 'key-id',
      AWS_SECRET_ACCESS_KEY: 'secret-key',
      AWS_SESSION_TOKEN: 'session-token',
      AWS_PROFILE: 'must-not-pass',
      HTTPS_PROXY: 'https://must-not-pass.example',
      SESSION_CAPABILITY_SECRET: 'must-not-pass',
    };

    expect(selectAwsCredentialEnvironment(source)).toEqual({
      AWS_ACCESS_KEY_ID: 'key-id',
      AWS_SECRET_ACCESS_KEY: 'secret-key',
      AWS_SESSION_TOKEN: 'session-token',
    });

    expect(
      buildVerifierEnvironment(
        {
          home: '/tmp/invocation/home',
          notationConfig: '/tmp/invocation/config',
          notationCache: '/tmp/invocation/cache',
          notationLibexec: '/tmp/invocation/libexec',
          dockerConfig: '/tmp/invocation/docker',
          temp: '/tmp/invocation/tmp',
          bin: '/opt/verifier/bin',
        },
        validInvocation,
        source,
      ),
    ).toEqual({
      HOME: '/tmp/invocation/home',
      NOTATION_CONFIG: '/tmp/invocation/config',
      NOTATION_CACHE: '/tmp/invocation/cache',
      NOTATION_LIBEXEC: '/tmp/invocation/libexec',
      DOCKER_CONFIG: '/tmp/invocation/docker',
      TMPDIR: '/tmp/invocation/tmp',
      PATH: '/opt/verifier/bin',
      AWS_REGION: 'ap-northeast-1',
      AWS_DEFAULT_REGION: 'ap-northeast-1',
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_ACCESS_KEY_ID: 'key-id',
      AWS_SECRET_ACCESS_KEY: 'secret-key',
      AWS_SESSION_TOKEN: 'session-token',
    });
  });

  it('allows only the CodeBuild relative-URI credential source and rejects ambiguous or partial credentials', () => {
    expect(
      selectAwsCredentialEnvironment({
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/opaque',
        AWS_PROFILE: 'must-not-pass',
      }),
    ).toEqual({
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/opaque',
    });

    for (const invalid of [
      {},
      { AWS_ACCESS_KEY_ID: 'partial' },
      {
        AWS_ACCESS_KEY_ID: 'key-id',
        AWS_SECRET_ACCESS_KEY: 'secret-key',
        AWS_SESSION_TOKEN: 'session-token',
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/opaque',
      },
      {
        AWS_ACCESS_KEY_ID: 'key-id',
        AWS_SECRET_ACCESS_KEY: 'secret-key',
        AWS_SESSION_TOKEN: 'session-token',
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: 'http://attacker.invalid/credentials',
      },
      { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: 'http://attacker.invalid/credentials' },
    ]) {
      expect(selectAwsCredentialEnvironment(invalid)).toBeUndefined();
    }
  });
});
