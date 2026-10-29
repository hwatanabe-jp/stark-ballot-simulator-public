import { createEcrSigningStatusLookup } from './signing-status.mjs';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isImageVerificationResult, verifyImageSignature } from './verifier.mjs';

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
  return parseCliPaths(argv[1], argv[3]);
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
  const configuration = parseCliConfiguration(options.environment);
  if (!args || !configuration) {
    emitBoundedResultLog(log, 'VERIFIER_ERROR');
    return 4;
  }

  if (!(await canCreateVerifierResult(args.outputPath))) {
    emitBoundedResultLog(log, 'VERIFIER_ERROR');
    return 4;
  }

  /** @type {Record<string, unknown>} */
  let result;
  try {
    result = await runCliVerification(args.inputPath, configuration, options);
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

/** @param {string} input @param {string} output */
function parseCliPaths(input, output) {
  const inputPath = path.resolve(input);
  const outputPath = path.resolve(output);
  if (inputPath === outputPath || outputPath === path.parse(outputPath).root) {
    return undefined;
  }
  return { inputPath, outputPath };
}

/** @param {Record<string,string|undefined>} environment */
function parseCliConfiguration(environment) {
  const assetRoot = environment['IMAGE_SIGNATURE_VERIFIER_ASSET_ROOT'];
  const maxStatusAttempts = parseBoundedInteger(environment['IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPTS'], 4, 1, 10);
  const statusAttemptTimeoutMs = parseBoundedInteger(
    environment['IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPT_TIMEOUT_MS'],
    5_000,
    250,
    15_000,
  );
  const statusRetryDelayMs = parseBoundedInteger(
    environment['IMAGE_SIGNATURE_VERIFIER_STATUS_RETRY_DELAY_MS'],
    1_000,
    0,
    5_000,
  );
  const verifierTimeoutMs = parseBoundedInteger(
    environment['IMAGE_SIGNATURE_VERIFIER_TIMEOUT_MS'],
    20_000,
    1_000,
    60_000,
  );
  if (
    typeof assetRoot !== 'string' ||
    !path.isAbsolute(assetRoot) ||
    maxStatusAttempts === undefined ||
    statusAttemptTimeoutMs === undefined ||
    statusRetryDelayMs === undefined ||
    verifierTimeoutMs === undefined
  ) {
    return undefined;
  }
  return { assetRoot, maxStatusAttempts, statusAttemptTimeoutMs, statusRetryDelayMs, verifierTimeoutMs };
}

/** @param {string} outputPath */
async function canCreateVerifierResult(outputPath) {
  try {
    await lstat(outputPath);
    return false;
  } catch (error) {
    return isRecord(error) && error['code'] === 'ENOENT';
  }
}

/** @param {string} inputPath @param {NonNullable<ReturnType<typeof parseCliConfiguration>>} configuration @param {VerifierCliOptions} options */
async function runCliVerification(inputPath, configuration, options) {
  const { assetRoot, maxStatusAttempts, statusAttemptTimeoutMs, statusRetryDelayMs, verifierTimeoutMs } = configuration;
  const inputDetails = await lstat(inputPath);
  if (
    !inputDetails.isFile() ||
    inputDetails.isSymbolicLink() ||
    inputDetails.size === 0 ||
    inputDetails.size > maximumInvocationBytes
  ) {
    throw new Error('Invocation file contract is invalid.');
  }
  const invocation = JSON.parse(await readFile(inputPath, 'utf8'));
  const temporaryRoot = path.resolve(options.temporaryRoot ?? os.tmpdir());
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const verify = options.verify ?? verifyImageSignature;
  const result = /** @type {Record<string, unknown>} */ (
    await verify(invocation, {
      assetRoot,
      temporaryRoot,
      expectedArchitecture: options.nativeArchitecture,
      sourceEnvironment: options.environment,
      maxStatusAttempts,
      statusAttemptTimeoutMs,
      statusRetryDelayMs,
      verifierTimeoutMs,
      describeSigningStatus: options.describeSigningStatus ?? createEcrSigningStatusLookup(),
    })
  );
  if (!isImageVerificationResult(result)) {
    throw new Error('Verifier returned an invalid result contract.');
  }
  return result;
}
