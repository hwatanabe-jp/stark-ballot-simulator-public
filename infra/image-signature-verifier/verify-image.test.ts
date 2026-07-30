import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runVerifierCli } from './verify-image.mjs';

const cleanupDirectories: string[] = [];
const imageDigest = `sha256:${'1'.repeat(64)}`;
const invocation = {
  imageUri: `123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/stark-ballot/prover@${imageDigest}`,
  registryId: '123456789012',
  imageRegion: 'ap-northeast-1',
  repositoryName: 'stark-ballot/prover',
  imageDigest,
  signingProfileArn: 'arn:aws:signer:ap-northeast-1:123456789012:/signing-profiles/stark_ballot_image_signing',
};

afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true })));
});

describe('image signature verifier CLI', () => {
  it('reads one bounded invocation file and writes only the sanitized VERIFIED result', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'image-signature-verifier-cli-'));
    cleanupDirectories.push(root);
    const inputPath = path.join(root, 'invocation.json');
    const outputPath = path.join(root, 'result.json');
    const assetRoot = path.join(root, 'assets');
    await mkdir(assetRoot, { mode: 0o700 });
    await writeFile(inputPath, `${JSON.stringify(invocation)}\n`);
    const safeResult = {
      result: 'VERIFIED' as const,
      mode: 'cryptographic' as const,
      verifierVersion: 'notation@1.3.2+aws-signer-plugin@1.0.2292',
      verifierAssets: {
        notationVersion: '1.3.2' as const,
        awsSignerPluginVersion: '1.0.2292' as const,
        ecrCredentialHelperVersion: '0.12.0' as const,
        trustRootSha256: 'c'.repeat(64),
      },
      trustPolicySha256: 'a'.repeat(64),
      assetManifestSha256: 'b'.repeat(64),
    };
    const verify = vi.fn(async () => await Promise.resolve(safeResult));
    const logs: string[] = [];

    await expect(
      runVerifierCli({
        argv: ['--input', inputPath, '--output', outputPath],
        environment: {
          IMAGE_SIGNATURE_VERIFIER_ASSET_ROOT: assetRoot,
          IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPTS: '3',
          IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPT_TIMEOUT_MS: '1000',
          IMAGE_SIGNATURE_VERIFIER_STATUS_RETRY_DELAY_MS: '250',
          IMAGE_SIGNATURE_VERIFIER_TIMEOUT_MS: '19000',
          AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/opaque',
          AWS_PROFILE: 'must-not-reach-child',
        },
        nativeArchitecture: 'amd64',
        temporaryRoot: path.join(root, 'tmp'),
        verify,
        describeSigningStatus: async () => await Promise.resolve([]),
        log: (line: string) => logs.push(line),
      }),
    ).resolves.toBe(0);

    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(safeResult);
    expect(verify).toHaveBeenCalledWith(
      invocation,
      expect.objectContaining({
        assetRoot,
        temporaryRoot: path.join(root, 'tmp'),
        expectedArchitecture: 'amd64',
        maxStatusAttempts: 3,
        statusAttemptTimeoutMs: 1_000,
        statusRetryDelayMs: 250,
        verifierTimeoutMs: 19_000,
      }),
    );
    expect(logs).toEqual([
      `${JSON.stringify({
        service: 'image-signature-verifier',
        event: 'verification_completed',
        result: 'VERIFIED',
      })}\n`,
    ]);
    expect(logs.join('')).not.toContain(imageDigest);
    expect(logs.join('')).not.toContain(invocation.signingProfileArn);
  });

  it('maps each sanitized result to a stable process exit code', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'image-signature-verifier-cli-exits-'));
    cleanupDirectories.push(root);
    const assetRoot = path.join(root, 'assets');
    await mkdir(assetRoot, { mode: 0o700 });

    for (const [result, expectedExitCode] of [
      [
        {
          result: 'VERIFICATION_FAILED',
          mode: 'cryptographic',
          reasonCode: 'CRYPTOGRAPHIC_VERIFICATION_FAILED',
        },
        2,
      ],
      [
        {
          result: 'VERIFIER_TIMEOUT',
          mode: 'cryptographic',
          reasonCode: 'CRYPTOGRAPHIC_VERIFIER_TIMEOUT',
        },
        3,
      ],
      [
        {
          result: 'VERIFIER_ERROR',
          mode: 'cryptographic',
          reasonCode: 'CRYPTOGRAPHIC_VERIFIER_ERROR',
        },
        4,
      ],
    ] as const) {
      const suffix = String(expectedExitCode);
      const inputPath = path.join(root, `invocation-${suffix}.json`);
      const outputPath = path.join(root, `result-${suffix}.json`);
      await writeFile(inputPath, `${JSON.stringify(invocation)}\n`);

      await expect(
        runVerifierCli({
          argv: ['--input', inputPath, '--output', outputPath],
          environment: {
            IMAGE_SIGNATURE_VERIFIER_ASSET_ROOT: assetRoot,
            AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/opaque',
          },
          nativeArchitecture: 'amd64',
          temporaryRoot: path.join(root, 'tmp'),
          verify: async () => await Promise.resolve(result),
          describeSigningStatus: async () => await Promise.resolve([]),
          log: () => undefined,
        }),
      ).resolves.toBe(expectedExitCode);
      expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(result);
    }
  });

  it('rejects malformed arguments and timeout settings without exposing input or overwriting output', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'image-signature-verifier-cli-invalid-'));
    cleanupDirectories.push(root);
    const inputPath = path.join(root, 'private-input.json');
    const outputPath = path.join(root, 'result.json');
    await writeFile(inputPath, 's3://private-bucket/private-key');
    await writeFile(outputPath, 'do-not-overwrite');
    const logs: string[] = [];
    const verify = vi.fn();

    await expect(
      runVerifierCli({
        argv: ['--input', inputPath, '--output', outputPath],
        environment: {
          IMAGE_SIGNATURE_VERIFIER_ASSET_ROOT: path.join(root, 'assets'),
          IMAGE_SIGNATURE_VERIFIER_TIMEOUT_MS: 'unbounded',
        },
        nativeArchitecture: 'amd64',
        temporaryRoot: path.join(root, 'tmp'),
        verify,
        describeSigningStatus: async () => await Promise.resolve([]),
        log: (line: string) => logs.push(line),
      }),
    ).resolves.toBe(4);

    expect(await readFile(outputPath, 'utf8')).toBe('do-not-overwrite');
    expect(verify).not.toHaveBeenCalled();
    expect(logs.join('')).not.toContain('private-bucket');
    expect(logs.join('')).not.toContain(inputPath);
  });
});
