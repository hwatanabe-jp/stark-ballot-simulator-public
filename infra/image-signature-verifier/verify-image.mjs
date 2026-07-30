import * as ecr from '@aws-sdk/client-ecr';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyImageSignature } from './verifier.mjs';

const { DescribeImageSigningStatusCommand, ECRClient } = ecr;
const maximumInvocationBytes = 16 * 1024;

/**
 * @param {string | undefined} value
 * @param {number} defaultValue
 * @param {number} minimum
 * @param {number} maximum
 * @returns {number | undefined}
 */
function parseBoundedInteger(value, defaultValue, minimum, maximum) {
  if (value === undefined) {
    return defaultValue;
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

/**
 * @param {readonly string[]} argv
 * @returns {{ inputPath: string; outputPath: string } | undefined}
 */
function parseCliArguments(argv) {
  if (
    argv.length !== 4 ||
    argv[0] !== '--input' ||
    typeof argv[1] !== 'string' ||
    argv[1].length === 0 ||
    argv[2] !== '--output' ||
    typeof argv[3] !== 'string' ||
    argv[3].length === 0
  ) {
    return undefined;
  }
  const inputPath = path.resolve(argv[1]);
  const outputPath = path.resolve(argv[3]);
  if (inputPath === outputPath || outputPath === path.parse(outputPath).root) {
    return undefined;
  }
  return { inputPath, outputPath };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} result
 * @returns {boolean}
 */
function isSanitizedResult(result) {
  if (!isRecord(result) || result['mode'] !== 'cryptographic') {
    return false;
  }
  if (result['result'] === 'VERIFIED') {
    const assets = result['verifierAssets'];
    return (
      Object.keys(result).sort().join('\0') ===
        'assetManifestSha256\0mode\0result\0trustPolicySha256\0verifierAssets\0verifierVersion' &&
      result['verifierVersion'] === 'notation@1.3.2+aws-signer-plugin@1.0.2292' &&
      /^[0-9a-f]{64}$/.test(String(result['trustPolicySha256'])) &&
      /^[0-9a-f]{64}$/.test(String(result['assetManifestSha256'])) &&
      isRecord(assets) &&
      Object.keys(assets).sort().join('\0') ===
        'awsSignerPluginVersion\0ecrCredentialHelperVersion\0notationVersion\0trustRootSha256' &&
      assets['notationVersion'] === '1.3.2' &&
      assets['awsSignerPluginVersion'] === '1.0.2292' &&
      assets['ecrCredentialHelperVersion'] === '0.12.0' &&
      /^[0-9a-f]{64}$/.test(String(assets['trustRootSha256']))
    );
  }
  return (
    (result['result'] === 'VERIFICATION_FAILED' ||
      result['result'] === 'VERIFIER_TIMEOUT' ||
      result['result'] === 'VERIFIER_ERROR') &&
    Object.keys(result).sort().join('\0') === 'mode\0reasonCode\0result' &&
    typeof result['reasonCode'] === 'string' &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(result['reasonCode'])
  );
}

/**
 * @param {unknown} result
 * @returns {0 | 2 | 3 | 4}
 */
function exitCodeForResult(result) {
  if (!isRecord(result)) return 4;
  switch (result['result']) {
    case 'VERIFIED':
      return 0;
    case 'VERIFICATION_FAILED':
      return 2;
    case 'VERIFIER_TIMEOUT':
      return 3;
    default:
      return 4;
  }
}

/**
 * @param {(line: string) => void} log
 * @param {string} result
 */
function emitBoundedResultLog(log, result) {
  log(
    `${JSON.stringify({
      service: 'image-signature-verifier',
      event: 'verification_completed',
      result,
    })}\n`,
  );
}

/**
 * @param {string} outputPath
 * @param {Record<string, unknown>} result
 */
async function writeSanitizedResult(outputPath, result) {
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${JSON.stringify(result)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  await chmod(outputPath, 0o600);
}

/**
 * @returns {(
 *   invocation: import('./verifier.mjs').ImageSignatureInvocation,
 *   abortSignal: AbortSignal
 * ) => Promise<unknown>}
 */
function createSigningStatusLookup() {
  /** @type {Map<string, InstanceType<typeof ECRClient>>} */
  const clients = new Map();
  return async (invocation, abortSignal) => {
    let client = clients.get(invocation.imageRegion);
    if (!client) {
      client = new ECRClient({ region: invocation.imageRegion });
      clients.set(invocation.imageRegion, client);
    }
    const response = await client.send(
      new DescribeImageSigningStatusCommand({
        registryId: invocation.registryId,
        repositoryName: invocation.repositoryName,
        imageId: { imageDigest: invocation.imageDigest },
      }),
      { abortSignal },
    );
    return response.signingStatuses;
  };
}

/**
 * @typedef {{
 *   argv: readonly string[];
 *   environment: Record<string, string | undefined>;
 *   nativeArchitecture: 'amd64' | 'arm64';
 *   temporaryRoot?: string;
 *   verify?: typeof verifyImageSignature;
 *   describeSigningStatus?: (
 *     invocation: import('./verifier.mjs').ImageSignatureInvocation,
 *     abortSignal: AbortSignal
 *   ) => Promise<unknown>;
 *   log?: (line: string) => void;
 * }} VerifierCliOptions
 */

/**
 * @param {VerifierCliOptions} options
 * @returns {Promise<0 | 2 | 3 | 4>}
 */
export async function runVerifierCli(options) {
  const log = options.log ?? ((line) => process.stderr.write(line));
  const args = parseCliArguments(options.argv);
  const assetRoot = options.environment['IMAGE_SIGNATURE_VERIFIER_ASSET_ROOT'];
  const maxStatusAttempts = parseBoundedInteger(
    options.environment['IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPTS'],
    4,
    1,
    10,
  );
  const statusAttemptTimeoutMs = parseBoundedInteger(
    options.environment['IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPT_TIMEOUT_MS'],
    5_000,
    250,
    15_000,
  );
  const statusRetryDelayMs = parseBoundedInteger(
    options.environment['IMAGE_SIGNATURE_VERIFIER_STATUS_RETRY_DELAY_MS'],
    1_000,
    0,
    5_000,
  );
  const verifierTimeoutMs = parseBoundedInteger(
    options.environment['IMAGE_SIGNATURE_VERIFIER_TIMEOUT_MS'],
    20_000,
    1_000,
    60_000,
  );
  if (
    !args ||
    typeof assetRoot !== 'string' ||
    !path.isAbsolute(assetRoot) ||
    maxStatusAttempts === undefined ||
    statusAttemptTimeoutMs === undefined ||
    statusRetryDelayMs === undefined ||
    verifierTimeoutMs === undefined
  ) {
    emitBoundedResultLog(log, 'VERIFIER_ERROR');
    return 4;
  }

  try {
    await lstat(args.outputPath);
    emitBoundedResultLog(log, 'VERIFIER_ERROR');
    return 4;
  } catch (error) {
    if (!isRecord(error) || error['code'] !== 'ENOENT') {
      emitBoundedResultLog(log, 'VERIFIER_ERROR');
      return 4;
    }
  }

  /** @type {Record<string, unknown>} */
  let result;
  try {
    const inputDetails = await lstat(args.inputPath);
    if (
      !inputDetails.isFile() ||
      inputDetails.isSymbolicLink() ||
      inputDetails.size === 0 ||
      inputDetails.size > maximumInvocationBytes
    ) {
      throw new Error('Invocation file contract is invalid.');
    }
    const invocation = JSON.parse(await readFile(args.inputPath, 'utf8'));
    const temporaryRoot = path.resolve(options.temporaryRoot ?? os.tmpdir());
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    const verify = options.verify ?? verifyImageSignature;
    result = /** @type {Record<string, unknown>} */ (
      await verify(invocation, {
        assetRoot,
        temporaryRoot,
        expectedArchitecture: options.nativeArchitecture,
        sourceEnvironment: options.environment,
        maxStatusAttempts,
        statusAttemptTimeoutMs,
        statusRetryDelayMs,
        verifierTimeoutMs,
        describeSigningStatus: options.describeSigningStatus ?? createSigningStatusLookup(),
      })
    );
    if (!isSanitizedResult(result)) {
      throw new Error('Verifier returned an invalid result contract.');
    }
  } catch {
    result = {
      result: 'VERIFIER_ERROR',
      mode: 'cryptographic',
      reasonCode: 'CLI_CONTRACT_ERROR',
    };
  }

  try {
    await writeSanitizedResult(args.outputPath, result);
  } catch {
    emitBoundedResultLog(log, 'VERIFIER_ERROR');
    return 4;
  }
  emitBoundedResultLog(log, /** @type {string} */ (result['result']));
  return exitCodeForResult(result);
}

async function main() {
  const nativeArchitecture = process.arch === 'x64' ? 'amd64' : process.arch;
  if (nativeArchitecture !== 'amd64' && nativeArchitecture !== 'arm64') {
    process.stderr.write(
      `${JSON.stringify({
        service: 'image-signature-verifier',
        event: 'verification_completed',
        result: 'VERIFIER_ERROR',
      })}\n`,
    );
    process.exitCode = 4;
    return;
  }
  process.exitCode = await runVerifierCli({
    argv: process.argv.slice(2),
    environment: process.env,
    nativeArchitecture,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
