import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLambdaRuntimeAssetModeCompatible, runNotationProcess, verifyImageSignature } from './verifier.mjs';

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
const lambdaCredentials = {
  AWS_ACCESS_KEY_ID: 'lambda-access-key',
  AWS_SECRET_ACCESS_KEY: 'lambda-secret-key',
  AWS_SESSION_TOKEN: 'lambda-session-token',
  AWS_PROFILE: 'must-not-pass',
  HTTPS_PROXY: 'https://must-not-pass.example',
  VOTE_SECRET_ENCRYPTION_KEY: 'must-not-pass',
};

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function writeAsset(
  root: string,
  relativePath: string,
  contents: Uint8Array,
  mode: number,
): Promise<{ path: string; sha256: string; mode: string; size: number }> {
  const destination = path.join(root, relativePath);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, contents, { mode });
  await chmod(destination, mode);
  return {
    path: relativePath,
    sha256: digest(contents),
    mode: mode.toString(8).padStart(4, '0'),
    size: contents.byteLength,
  };
}

async function createAssetFixture(root: string): Promise<{
  assetManifestSha256: string;
  trustRootSha256: string;
}> {
  const notation = Buffer.from('fixture-notation');
  const plugin = Buffer.from('fixture-plugin');
  const helper = Buffer.from('fixture-helper');
  const trustRoot = Buffer.from('fixture-trust-root');
  const manifest = {
    kind: 'image-signature-verifier-assets',
    verifierVersion: 'notation@1.3.2+aws-signer-plugin@1.0.2292',
    platforms: {
      'linux-amd64': {
        os: 'linux',
        architecture: 'amd64',
        elfMachine: 62,
        notation: {
          version: '1.3.2',
          executableSha256: digest(notation),
          installedPath: 'bin/notation',
        },
        awsSignerPlugin: {
          version: '1.0.2292',
          executableSha256: digest(plugin),
          installedPath:
            'libexec/plugins/com.amazonaws.signer.notation.plugin/notation-com.amazonaws.signer.notation.plugin',
        },
        ecrCredentialHelper: {
          version: '0.12.0',
          executableSha256: digest(helper),
          installedPath: 'bin/docker-credential-ecr-login',
        },
      },
    },
    trustRoot: {
      name: 'aws-signer-ts',
      sha256: digest(trustRoot),
      installedPath: 'trust/aws-signer-notation-root.cert',
    },
  };
  const manifestRaw = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const files = await Promise.all([
    writeAsset(root, 'bin/notation', notation, 0o755),
    writeAsset(
      root,
      'libexec/plugins/com.amazonaws.signer.notation.plugin/notation-com.amazonaws.signer.notation.plugin',
      plugin,
      0o755,
    ),
    writeAsset(root, 'bin/docker-credential-ecr-login', helper, 0o755),
    writeAsset(root, 'trust/aws-signer-notation-root.cert', trustRoot, 0o644),
    writeAsset(root, 'asset-manifest.json', manifestRaw, 0o644),
  ]);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const installation = {
    kind: 'image-signature-verifier-installation',
    architecture: 'amd64',
    verifierVersion: manifest.verifierVersion,
    assetManifestSha256: digest(manifestRaw),
    trustRootSha256: digest(trustRoot),
    files,
  };
  await writeAsset(root, 'installation.json', Buffer.from(`${JSON.stringify(installation, null, 2)}\n`), 0o644);
  return {
    assetManifestSha256: installation.assetManifestSha256,
    trustRootSha256: installation.trustRootSha256,
  };
}

afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true })));
});

describe('shared cryptographic image verifier runtime', () => {
  it('isolates Lambda runtime mode normalization behind a bounded adapter', () => {
    for (const actualMode of [0o444, 0o555, 0o644, 0o755]) {
      expect(isLambdaRuntimeAssetModeCompatible('0644', actualMode)).toBe(true);
    }
    for (const actualMode of [0o400, 0o600, 0o664, 0o666, 0o744, 0o777, 0o4755]) {
      expect(isLambdaRuntimeAssetModeCompatible('0644', actualMode)).toBe(false);
    }

    for (const actualMode of [0o555, 0o755]) {
      expect(isLambdaRuntimeAssetModeCompatible('0755', actualMode)).toBe(true);
    }
    for (const actualMode of [0o444, 0o544, 0o644, 0o754, 0o775, 0o777, 0o4755]) {
      expect(isLambdaRuntimeAssetModeCompatible('0755', actualMode)).toBe(false);
    }
  });

  it('accepts only the bounded read-only or executable Lambda runtime projections', async () => {
    const testRoot = await mkdtemp(path.join(os.tmpdir(), 'image-signature-verifier-runtime-mode-'));
    cleanupDirectories.push(testRoot);
    const assetRoot = path.join(testRoot, 'assets');
    const temporaryRoot = path.join(testRoot, 'invocations');
    await mkdir(assetRoot, { mode: 0o700 });
    await mkdir(temporaryRoot, { mode: 0o700 });
    await createAssetFixture(assetRoot);

    const installation = JSON.parse(await readFile(path.join(assetRoot, 'installation.json'), 'utf8')) as {
      files: Array<{ mode: '0644' | '0755'; path: string }>;
    };
    for (const file of installation.files) {
      await chmod(path.join(assetRoot, file.path), file.mode === '0755' ? 0o555 : 0o755);
    }
    await chmod(path.join(assetRoot, 'installation.json'), 0o444);

    await expect(
      verifyImageSignature(invocation, {
        assetRoot,
        temporaryRoot,
        expectedArchitecture: 'amd64',
        sourceEnvironment: lambdaCredentials,
        maxStatusAttempts: 1,
        statusAttemptTimeoutMs: 1_000,
        statusRetryDelayMs: 0,
        verifierTimeoutMs: 19_000,
        describeSigningStatus: async () =>
          await Promise.resolve([{ signingProfileArn: invocation.signingProfileArn, status: 'COMPLETE' }]),
        runNotation: async () => await Promise.resolve({ kind: 'success' as const }),
      }),
    ).resolves.toMatchObject({
      result: 'VERIFIED',
      mode: 'cryptographic',
    });
  });

  it('reports bounded size and hash diagnostics without exposing asset contents', async () => {
    for (const [mutation, expectedReason] of [
      ['size', 'ASSET_FILE_SIZE_INVALID'],
      ['hash', 'ASSET_FILE_HASH_INVALID'],
    ] as const) {
      const testRoot = await mkdtemp(path.join(os.tmpdir(), `image-signature-verifier-${mutation}-`));
      cleanupDirectories.push(testRoot);
      const assetRoot = path.join(testRoot, 'assets');
      const temporaryRoot = path.join(testRoot, 'invocations');
      await mkdir(assetRoot, { mode: 0o700 });
      await mkdir(temporaryRoot, { mode: 0o700 });
      await createAssetFixture(assetRoot);

      const notationPath = path.join(assetRoot, 'bin/notation');
      const original = await readFile(notationPath);
      const replacement =
        mutation === 'size'
          ? Buffer.concat([original, Buffer.from('private-extra-byte')])
          : Buffer.from(original.map((byte, index) => (index === 0 ? byte ^ 0xff : byte)));
      await writeFile(notationPath, replacement);
      await chmod(notationPath, 0o755);

      const result = await verifyImageSignature(invocation, {
        assetRoot,
        temporaryRoot,
        expectedArchitecture: 'amd64',
        sourceEnvironment: lambdaCredentials,
        maxStatusAttempts: 1,
        statusAttemptTimeoutMs: 1_000,
        statusRetryDelayMs: 0,
        verifierTimeoutMs: 19_000,
        describeSigningStatus: async () =>
          await Promise.resolve([{ signingProfileArn: invocation.signingProfileArn, status: 'COMPLETE' }]),
        runNotation: vi.fn(),
      });
      expect(result).toEqual({
        result: 'VERIFIER_ERROR',
        mode: 'cryptographic',
        reasonCode: expectedReason,
      });
      expect(JSON.stringify(result)).not.toContain('private-extra-byte');
    }
  });

  it('uses bounded execFile semantics without interpreting verifier output', async () => {
    const environment: Record<string, string> = { PATH: process.env['PATH'] ?? '' };
    await expect(
      runNotationProcess({
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("private output");'],
        environment,
        timeoutMs: 2_000,
        maxBuffer: 1_024,
      }),
    ).resolves.toEqual({ kind: 'success' });
    await expect(
      runNotationProcess({
        executable: process.execPath,
        args: ['-e', 'process.stderr.write("private output"); process.exit(9);'],
        environment,
        timeoutMs: 2_000,
        maxBuffer: 1_024,
      }),
    ).resolves.toEqual({ kind: 'exit' });
    await expect(
      runNotationProcess({
        executable: process.execPath,
        args: ['-e', 'setInterval(() => undefined, 1000);'],
        environment,
        timeoutMs: 10,
        maxBuffer: 1_024,
      }),
    ).resolves.toEqual({ kind: 'timeout' });
    await expect(
      runNotationProcess({
        executable: path.join(os.tmpdir(), 'missing-image-signature-verifier'),
        args: ['verify', invocation.imageUri],
        environment,
        timeoutMs: 2_000,
        maxBuffer: 1_024,
      }),
    ).resolves.toEqual({ kind: 'spawn_error' });
    await expect(
      runNotationProcess({
        executable: process.execPath,
        args: ['-e', "process.kill(process.pid, 'SIGTERM');"],
        environment,
        timeoutMs: 2_000,
        maxBuffer: 1_024,
      }),
    ).resolves.toEqual({ kind: 'signal' });
  });

  it('runs strict Notation verification in an isolated workspace and returns only bounded evidence', async () => {
    const testRoot = await mkdtemp(path.join(os.tmpdir(), 'image-signature-verifier-runtime-'));
    cleanupDirectories.push(testRoot);
    const assetRoot = path.join(testRoot, 'assets');
    const temporaryRoot = path.join(testRoot, 'invocations');
    await mkdir(assetRoot, { mode: 0o700 });
    await mkdir(temporaryRoot, { mode: 0o700 });
    const assets = await createAssetFixture(assetRoot);

    const runNotation = vi.fn(async (request: Record<string, unknown>) => {
      expect(request['executable']).toBe(path.join(assetRoot, 'bin/notation'));
      expect(request['args']).toEqual(['verify', invocation.imageUri]);
      expect(request['timeoutMs']).toBe(19_000);
      expect(request['maxBuffer']).toBe(65_536);
      const environment = request['environment'] as Record<string, string>;
      const home = environment['HOME'];
      const notationConfig = environment['NOTATION_CONFIG'];
      const notationCache = environment['NOTATION_CACHE'];
      const notationLibexec = environment['NOTATION_LIBEXEC'];
      const dockerConfig = environment['DOCKER_CONFIG'];
      const temp = environment['TMPDIR'];
      if (
        home === undefined ||
        notationConfig === undefined ||
        notationCache === undefined ||
        notationLibexec === undefined ||
        dockerConfig === undefined ||
        temp === undefined
      ) {
        throw new Error('Missing required verifier environment paths.');
      }
      expect(home).toMatch(/^.+\/home$/);
      expect(notationConfig).toMatch(/^.+\/config$/);
      expect(notationCache).toMatch(/^.+\/cache$/);
      expect(notationLibexec).toMatch(/^.+\/libexec$/);
      expect(dockerConfig).toMatch(/^.+\/docker$/);
      expect(temp).toMatch(/^.+\/tmp$/);
      expect(environment).toEqual({
        HOME: home,
        NOTATION_CONFIG: notationConfig,
        NOTATION_CACHE: notationCache,
        NOTATION_LIBEXEC: notationLibexec,
        DOCKER_CONFIG: dockerConfig,
        TMPDIR: temp,
        PATH: path.join(assetRoot, 'bin'),
        AWS_REGION: invocation.imageRegion,
        AWS_DEFAULT_REGION: invocation.imageRegion,
        AWS_EC2_METADATA_DISABLED: 'true',
        AWS_ACCESS_KEY_ID: lambdaCredentials.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: lambdaCredentials.AWS_SECRET_ACCESS_KEY,
        AWS_SESSION_TOKEN: lambdaCredentials.AWS_SESSION_TOKEN,
      });
      for (const name of ['HOME', 'NOTATION_CONFIG', 'NOTATION_CACHE', 'NOTATION_LIBEXEC', 'DOCKER_CONFIG', 'TMPDIR']) {
        const directory = environment[name];
        if (directory === undefined) {
          throw new Error(`Missing verifier environment path: ${name}`);
        }
        const details = await lstat(directory);
        expect((details.mode & 0o777).toString(8)).toBe('700');
      }

      const policyRaw = await readFile(path.join(notationConfig, 'trustpolicy.json'), 'utf8');
      expect(JSON.parse(policyRaw)).toEqual({
        version: '1.0',
        trustPolicies: [
          {
            name: 'aws-signer',
            registryScopes: ['123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/stark-ballot/prover'],
            signatureVerification: { level: 'strict' },
            trustStores: ['signingAuthority:aws-signer-ts'],
            trustedIdentities: [invocation.signingProfileArn],
          },
        ],
      });
      expect(JSON.parse(await readFile(path.join(dockerConfig, 'config.json'), 'utf8'))).toEqual({
        credHelpers: {
          '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com': 'ecr-login',
        },
      });
      expect(
        await readFile(
          path.join(
            notationLibexec,
            'plugins/com.amazonaws.signer.notation.plugin/notation-com.amazonaws.signer.notation.plugin',
          ),
          'utf8',
        ),
      ).toBe('fixture-plugin');
      return { kind: 'success' as const };
    });

    const result = await verifyImageSignature(invocation, {
      assetRoot,
      temporaryRoot,
      expectedArchitecture: 'amd64',
      sourceEnvironment: lambdaCredentials,
      maxStatusAttempts: 1,
      statusAttemptTimeoutMs: 1_000,
      statusRetryDelayMs: 0,
      verifierTimeoutMs: 19_000,
      describeSigningStatus: async () =>
        await Promise.resolve([{ signingProfileArn: invocation.signingProfileArn, status: 'COMPLETE' }]),
      runNotation,
    });

    if (result.result !== 'VERIFIED') {
      throw new Error('Expected cryptographic verification success.');
    }
    expect(result.trustPolicySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(result).sort()).toEqual([
      'assetManifestSha256',
      'mode',
      'result',
      'trustPolicySha256',
      'verifierAssets',
      'verifierVersion',
    ]);
    expect(result).toEqual({
      result: 'VERIFIED',
      mode: 'cryptographic',
      verifierVersion: 'notation@1.3.2+aws-signer-plugin@1.0.2292',
      verifierAssets: {
        notationVersion: '1.3.2',
        awsSignerPluginVersion: '1.0.2292',
        ecrCredentialHelperVersion: '0.12.0',
        trustRootSha256: assets.trustRootSha256,
      },
      trustPolicySha256: result.trustPolicySha256,
      assetManifestSha256: assets.assetManifestSha256,
    });
    expect(JSON.stringify(result)).not.toContain(invocation.imageDigest);
    expect(JSON.stringify(result)).not.toContain(invocation.signingProfileArn);
    expect(JSON.stringify(result)).not.toContain(lambdaCredentials.AWS_SECRET_ACCESS_KEY);
    expect(runNotation).toHaveBeenCalledOnce();
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  it('maps process exits, timeouts, wrapper errors, and readiness failures to the exact sanitized union', async () => {
    const testRoot = await mkdtemp(path.join(os.tmpdir(), 'image-signature-verifier-results-'));
    cleanupDirectories.push(testRoot);
    const assetRoot = path.join(testRoot, 'assets');
    const temporaryRoot = path.join(testRoot, 'invocations');
    await mkdir(assetRoot, { mode: 0o700 });
    await mkdir(temporaryRoot, { mode: 0o700 });
    await createAssetFixture(assetRoot);
    const baseDependencies = {
      assetRoot,
      temporaryRoot,
      expectedArchitecture: 'amd64' as const,
      sourceEnvironment: lambdaCredentials,
      maxStatusAttempts: 1,
      statusAttemptTimeoutMs: 1_000,
      statusRetryDelayMs: 0,
      verifierTimeoutMs: 19_000,
      describeSigningStatus: async () =>
        await Promise.resolve([{ signingProfileArn: invocation.signingProfileArn, status: 'COMPLETE' }]),
    };

    for (const [processResult, expected] of [
      [
        { kind: 'exit', stdout: 'digest and token must not escape', stderr: 'private ARN' },
        {
          result: 'VERIFICATION_FAILED',
          mode: 'cryptographic',
          reasonCode: 'CRYPTOGRAPHIC_VERIFICATION_FAILED',
        },
      ],
      [
        { kind: 'timeout', stderr: 'secret timeout output' },
        {
          result: 'VERIFIER_TIMEOUT',
          mode: 'cryptographic',
          reasonCode: 'CRYPTOGRAPHIC_VERIFIER_TIMEOUT',
        },
      ],
      [
        { kind: 'spawn_error', error: new Error('s3://private-bucket/private-key') },
        {
          result: 'VERIFIER_ERROR',
          mode: 'cryptographic',
          reasonCode: 'CRYPTOGRAPHIC_VERIFIER_SPAWN_ERROR',
        },
      ],
      [
        { kind: 'signal', stderr: 'private signal output' },
        {
          result: 'VERIFIER_ERROR',
          mode: 'cryptographic',
          reasonCode: 'CRYPTOGRAPHIC_VERIFIER_SIGNAL',
        },
      ],
    ] as const) {
      const result = await verifyImageSignature(invocation, {
        ...baseDependencies,
        runNotation: async () => await Promise.resolve(processResult),
      });
      expect(result).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain('private');
    }

    await expect(
      verifyImageSignature(invocation, {
        ...baseDependencies,
        runNotation: () => Promise.reject(new Error('private wrapper failure')),
      }),
    ).resolves.toEqual({
      result: 'VERIFIER_ERROR',
      mode: 'cryptographic',
      reasonCode: 'CRYPTOGRAPHIC_VERIFIER_WRAPPER_ERROR',
    });
    await expect(
      verifyImageSignature(invocation, {
        ...baseDependencies,
        runNotation: async () => await Promise.resolve({ kind: 'private-unknown-result' }),
      }),
    ).resolves.toEqual({
      result: 'VERIFIER_ERROR',
      mode: 'cryptographic',
      reasonCode: 'CRYPTOGRAPHIC_VERIFIER_RESULT_INVALID',
    });

    const runNotation = vi.fn();
    await expect(
      verifyImageSignature(invocation, {
        ...baseDependencies,
        describeSigningStatus: async () => await Promise.resolve([]),
        runNotation,
      }),
    ).resolves.toEqual({
      result: 'VERIFICATION_FAILED',
      mode: 'cryptographic',
      reasonCode: 'EXPECTED_PROFILE_MISSING',
    });
    expect(runNotation).not.toHaveBeenCalled();
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  it('rejects invalid credentials and corrupt packaged assets without executing Notation', async () => {
    const testRoot = await mkdtemp(path.join(os.tmpdir(), 'image-signature-verifier-closed-'));
    cleanupDirectories.push(testRoot);
    const assetRoot = path.join(testRoot, 'assets');
    const temporaryRoot = path.join(testRoot, 'invocations');
    await mkdir(assetRoot, { mode: 0o700 });
    await mkdir(temporaryRoot, { mode: 0o700 });
    await createAssetFixture(assetRoot);
    const runNotation = vi.fn();

    await expect(
      verifyImageSignature(invocation, {
        assetRoot,
        temporaryRoot,
        expectedArchitecture: 'amd64',
        sourceEnvironment: lambdaCredentials,
        maxStatusAttempts: 1,
        statusAttemptTimeoutMs: 1_000,
        statusRetryDelayMs: 0,
        verifierTimeoutMs: 19_000,
        expectedAssetManifestSha256: 'f'.repeat(64),
        expectedTrustRootSha256: 'e'.repeat(64),
        describeSigningStatus: async () =>
          await Promise.resolve([{ signingProfileArn: invocation.signingProfileArn, status: 'COMPLETE' }]),
        runNotation,
      }),
    ).resolves.toEqual({
      result: 'VERIFIER_ERROR',
      mode: 'cryptographic',
      reasonCode: 'ASSET_DEPLOYMENT_AUTHORITY_MISMATCH',
    });

    await expect(
      verifyImageSignature(invocation, {
        assetRoot,
        temporaryRoot,
        expectedArchitecture: 'amd64',
        sourceEnvironment: {
          ...lambdaCredentials,
          AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/ambiguous',
        },
        maxStatusAttempts: 1,
        statusAttemptTimeoutMs: 1_000,
        statusRetryDelayMs: 0,
        verifierTimeoutMs: 19_000,
        describeSigningStatus: async () =>
          await Promise.resolve([{ signingProfileArn: invocation.signingProfileArn, status: 'COMPLETE' }]),
        runNotation,
      }),
    ).resolves.toEqual({
      result: 'VERIFIER_ERROR',
      mode: 'cryptographic',
      reasonCode: 'CREDENTIAL_SOURCE_INVALID',
    });

    await chmod(path.join(assetRoot, 'bin/notation'), 0o777);
    await expect(
      verifyImageSignature(invocation, {
        assetRoot,
        temporaryRoot,
        expectedArchitecture: 'amd64',
        sourceEnvironment: lambdaCredentials,
        maxStatusAttempts: 1,
        statusAttemptTimeoutMs: 1_000,
        statusRetryDelayMs: 0,
        verifierTimeoutMs: 19_000,
        describeSigningStatus: async () =>
          await Promise.resolve([{ signingProfileArn: invocation.signingProfileArn, status: 'COMPLETE' }]),
        runNotation,
      }),
    ).resolves.toEqual({
      result: 'VERIFIER_ERROR',
      mode: 'cryptographic',
      reasonCode: 'ASSET_FILE_MODE_INVALID',
    });
    expect(runNotation).not.toHaveBeenCalled();
    expect(await readdir(temporaryRoot)).toEqual([]);
  });
});
