import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const invocationKeys = ['imageDigest', 'imageRegion', 'imageUri', 'registryId', 'repositoryName', 'signingProfileArn'];

const repositoryPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const signingProfileArnPattern =
  /^arn:aws(?:-[a-z]+)?:signer:[a-z0-9-]+:[0-9]{12}:\/signing-profiles\/[A-Za-z0-9_]{2,64}$/;
const verifierVersion = 'notation@1.3.2+aws-signer-plugin@1.0.2292';
const maximumAssetBytes = 128 * 1024 * 1024;
const spawnErrorCodes = new Set(['EACCES', 'EAGAIN', 'EMFILE', 'ENFILE', 'ENOENT', 'ENOEXEC', 'ENOMEM']);
const imageVerificationReasonCodes = new Set([
  'ASSET_AUTHORITY_INVALID',
  'ASSET_DEPLOYMENT_AUTHORITY_MISMATCH',
  'ASSET_DIRECTORY_INVALID',
  'ASSET_FILE_HASH_INVALID',
  'ASSET_FILE_MODE_INVALID',
  'ASSET_FILE_SIZE_INVALID',
  'ASSET_FILE_TYPE_INVALID',
  'ASSET_INSTALLATION_MODE_INVALID',
  'ASSET_INSTALLATION_RECORD_INVALID',
  'ASSET_IO_ERROR',
  'ASSET_METADATA_INVALID',
  'CREDENTIAL_SOURCE_INVALID',
  'CRYPTOGRAPHIC_VERIFICATION_FAILED',
  'CRYPTOGRAPHIC_VERIFIER_RESULT_INVALID',
  'CRYPTOGRAPHIC_VERIFIER_SIGNAL',
  'CRYPTOGRAPHIC_VERIFIER_SPAWN_ERROR',
  'CRYPTOGRAPHIC_VERIFIER_TIMEOUT',
  'CRYPTOGRAPHIC_VERIFIER_WRAPPER_ERROR',
  'EXPECTED_PROFILE_AMBIGUOUS',
  'EXPECTED_PROFILE_MISSING',
  'INVALID_INVOCATION',
  'MALFORMED_SIGNING_STATUS',
  'RUNTIME_SETUP_ERROR',
  'SIGNING_FAILED',
  'SIGNING_NOT_READY',
  'SIGNING_STATUS_LOOKUP_ERROR',
  'UNEXPECTED_PROFILE',
  'VERIFIER_CONTRACT_ERROR',
]);

/**
 * @typedef {'ASSET_METADATA_INVALID' |
 *   'ASSET_INSTALLATION_RECORD_INVALID' |
 *   'ASSET_DIRECTORY_INVALID' |
 *   'ASSET_FILE_HASH_INVALID' |
 *   'ASSET_FILE_MODE_INVALID' |
 *   'ASSET_FILE_SIZE_INVALID' |
 *   'ASSET_FILE_TYPE_INVALID' |
 *   'ASSET_INSTALLATION_MODE_INVALID' |
 *   'ASSET_AUTHORITY_INVALID'
 * } AssetDiagnosticReason
 */

class AssetDiagnosticError extends Error {
  /**
   * @param {AssetDiagnosticReason} reasonCode
   */
  constructor(reasonCode) {
    super(reasonCode);
    this.name = 'AssetDiagnosticError';
    this.reasonCode = reasonCode;
  }
}

/**
 * @param {unknown} error
 * @returns {AssetDiagnosticReason | 'ASSET_IO_ERROR'}
 */
function assetDiagnosticReason(error) {
  return error instanceof AssetDiagnosticError ? error.reasonCode : 'ASSET_IO_ERROR';
}

/**
 * @typedef {{
 *   imageUri: string;
 *   registryId: string;
 *   imageRegion: string;
 *   repositoryName: string;
 *   imageDigest: string;
 *   signingProfileArn: string;
 * }} ImageSignatureInvocation
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isImageVerificationReasonCode(value) {
  return typeof value === 'string' && imageVerificationReasonCodes.has(value);
}

/**
 * @param {unknown} event
 * @returns {ImageSignatureInvocation | undefined}
 */
export function parseImageSignatureInvocation(event) {
  try {
    if (!isRecord(event) || Object.keys(event).sort().join('\0') !== invocationKeys.join('\0')) {
      return undefined;
    }

    const imageUri = event['imageUri'];
    const registryId = event['registryId'];
    const imageRegion = event['imageRegion'];
    const repositoryName = event['repositoryName'];
    const imageDigest = event['imageDigest'];
    const signingProfileArn = event['signingProfileArn'];

    if (
      typeof imageUri !== 'string' ||
      typeof registryId !== 'string' ||
      !/^[0-9]{12}$/.test(registryId) ||
      typeof imageRegion !== 'string' ||
      !/^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/.test(imageRegion) ||
      typeof repositoryName !== 'string' ||
      repositoryName.length < 2 ||
      repositoryName.length > 256 ||
      !repositoryPattern.test(repositoryName) ||
      typeof imageDigest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(imageDigest) ||
      typeof signingProfileArn !== 'string'
    ) {
      return undefined;
    }

    const expectedImageUri = `${registryId}.dkr.ecr.${imageRegion}.amazonaws.com/${repositoryName}@${imageDigest}`;
    const expectedProfilePrefix = `arn:aws:signer:${imageRegion}:${registryId}:/signing-profiles/`;
    if (
      imageUri !== expectedImageUri ||
      !signingProfileArn.startsWith(expectedProfilePrefix) ||
      !/^[A-Za-z0-9_]{2,64}$/.test(signingProfileArn.slice(expectedProfilePrefix.length))
    ) {
      return undefined;
    }

    return {
      imageUri,
      registryId,
      imageRegion,
      repositoryName,
      imageDigest,
      signingProfileArn,
    };
  } catch {
    return undefined;
  }
}

/**
 * @typedef {'EXPECTED_PROFILE_MISSING' | 'SIGNING_NOT_READY'} RetryableSigningReason
 * @typedef {'SIGNING_FAILED' | RetryableSigningReason} FailedSigningReason
 * @typedef {'MALFORMED_SIGNING_STATUS' | 'UNEXPECTED_PROFILE' | 'EXPECTED_PROFILE_AMBIGUOUS' | 'SIGNING_STATUS_LOOKUP_ERROR' | 'VERIFIER_CONTRACT_ERROR'} SigningErrorReason
 * @typedef {{ kind: 'ready' } | { kind: 'retry'; reasonCode: RetryableSigningReason } | { kind: 'failed'; reasonCode: FailedSigningReason } | { kind: 'error'; reasonCode: SigningErrorReason }} SigningReadiness
 */

/**
 * @param {unknown} signingStatuses
 * @param {string} expectedProfileArn
 * @returns {SigningReadiness}
 */
export function inspectSigningStatuses(signingStatuses, expectedProfileArn) {
  if (!Array.isArray(signingStatuses)) {
    return { kind: 'error', reasonCode: 'MALFORMED_SIGNING_STATUS' };
  }
  if (signingStatuses.length === 0) {
    return { kind: 'retry', reasonCode: 'EXPECTED_PROFILE_MISSING' };
  }

  /** @type {Array<{ signingProfileArn: string; status: 'COMPLETE' | 'FAILED' | 'IN_PROGRESS' }>} */
  const parsedStatuses = [];
  for (const entry of signingStatuses) {
    if (!isRecord(entry)) {
      return { kind: 'error', reasonCode: 'MALFORMED_SIGNING_STATUS' };
    }
    const signingProfileArn = entry['signingProfileArn'];
    const status = entry['status'];
    if (
      typeof signingProfileArn !== 'string' ||
      !signingProfileArnPattern.test(signingProfileArn) ||
      (status !== 'COMPLETE' && status !== 'FAILED' && status !== 'IN_PROGRESS')
    ) {
      return { kind: 'error', reasonCode: 'MALFORMED_SIGNING_STATUS' };
    }
    parsedStatuses.push({ signingProfileArn, status });
  }

  if (parsedStatuses.some(({ signingProfileArn }) => signingProfileArn !== expectedProfileArn)) {
    return { kind: 'error', reasonCode: 'UNEXPECTED_PROFILE' };
  }
  if (parsedStatuses.length !== 1) {
    return { kind: 'error', reasonCode: 'EXPECTED_PROFILE_AMBIGUOUS' };
  }

  const singleStatus = /** @type {{ status: 'COMPLETE' | 'FAILED' | 'IN_PROGRESS' }} */ (parsedStatuses[0]);
  switch (singleStatus.status) {
    case 'COMPLETE':
      return { kind: 'ready' };
    case 'FAILED':
      return { kind: 'failed', reasonCode: 'SIGNING_FAILED' };
    case 'IN_PROGRESS':
      return { kind: 'retry', reasonCode: 'SIGNING_NOT_READY' };
  }
}

/**
 * @param {number} delayMs
 * @returns {Promise<void>}
 */
async function defaultSleep(delayMs) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * @typedef {{
 *   maxAttempts: number;
 *   attemptTimeoutMs: number;
 *   retryDelayMs: number;
 *   describeSigningStatus: (invocation: ImageSignatureInvocation, abortSignal: AbortSignal) => Promise<unknown>;
 *   sleep?: (delayMs: number) => Promise<void>;
 * }} SigningReadinessDependencies
 */

/**
 * @param {ImageSignatureInvocation} invocation
 * @param {SigningReadinessDependencies} dependencies
 * @returns {Promise<Exclude<SigningReadiness, { kind: 'retry' }>>}
 */
export async function pollSigningReadiness(invocation, dependencies) {
  const { maxAttempts, attemptTimeoutMs, retryDelayMs, describeSigningStatus, sleep = defaultSleep } = dependencies;
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    !Number.isSafeInteger(attemptTimeoutMs) ||
    attemptTimeoutMs < 1 ||
    !Number.isSafeInteger(retryDelayMs) ||
    retryDelayMs < 0
  ) {
    return { kind: 'error', reasonCode: 'VERIFIER_CONTRACT_ERROR' };
  }

  /** @type {RetryableSigningReason} */
  let terminalReason = 'EXPECTED_PROFILE_MISSING';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let signingStatuses;
    const abortController = new AbortController();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let attemptTimer;
    try {
      signingStatuses = await Promise.race([
        Promise.resolve(describeSigningStatus(invocation, abortController.signal)),
        new Promise((_, reject) => {
          attemptTimer = setTimeout(() => {
            abortController.abort();
            reject(new Error('Signing-status lookup timed out.'));
          }, attemptTimeoutMs);
        }),
      ]);
    } catch {
      return { kind: 'error', reasonCode: 'SIGNING_STATUS_LOOKUP_ERROR' };
    } finally {
      if (attemptTimer !== undefined) {
        clearTimeout(attemptTimer);
      }
    }

    const inspected = inspectSigningStatuses(signingStatuses, invocation.signingProfileArn);
    if (inspected.kind !== 'retry') {
      return inspected;
    }
    terminalReason = inspected.reasonCode;
    if (attempt < maxAttempts) {
      await sleep(retryDelayMs);
    }
  }

  return { kind: 'failed', reasonCode: terminalReason };
}

/**
 * @typedef {{
 *   AWS_ACCESS_KEY_ID: string;
 *   AWS_SECRET_ACCESS_KEY: string;
 *   AWS_SESSION_TOKEN: string;
 * } | {
 *   AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: string;
 * }} AwsCredentialEnvironment
 */

/**
 * @param {Record<string, string | undefined>} sourceEnvironment
 * @returns {AwsCredentialEnvironment | undefined}
 */
export function selectAwsCredentialEnvironment(sourceEnvironment) {
  const accessKeyId = sourceEnvironment['AWS_ACCESS_KEY_ID'];
  const secretAccessKey = sourceEnvironment['AWS_SECRET_ACCESS_KEY'];
  const sessionToken = sourceEnvironment['AWS_SESSION_TOKEN'];
  const containerCredentialsUri = sourceEnvironment['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'];

  const credentialValues = [accessKeyId, secretAccessKey, sessionToken];
  const hasAnySessionCredential = credentialValues.some((value) => value !== undefined);
  const hasCompleteSessionCredentials = credentialValues.every(
    (value) => typeof value === 'string' && value.length > 0 && value.length <= 4096,
  );
  const hasAnyContainerCredential = containerCredentialsUri !== undefined;
  const hasContainerCredentials =
    typeof containerCredentialsUri === 'string' && /^\/v2\/credentials\/[A-Za-z0-9-]+$/.test(containerCredentialsUri);

  if (
    (hasAnySessionCredential && !hasCompleteSessionCredentials) ||
    (hasAnySessionCredential && hasAnyContainerCredential) ||
    (hasAnyContainerCredential && !hasContainerCredentials) ||
    (!hasCompleteSessionCredentials && !hasContainerCredentials)
  ) {
    return undefined;
  }

  if (hasCompleteSessionCredentials) {
    return {
      AWS_ACCESS_KEY_ID: /** @type {string} */ (accessKeyId),
      AWS_SECRET_ACCESS_KEY: /** @type {string} */ (secretAccessKey),
      AWS_SESSION_TOKEN: /** @type {string} */ (sessionToken),
    };
  }

  return {
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: /** @type {string} */ (containerCredentialsUri),
  };
}

/**
 * @typedef {{
 *   home: string;
 *   notationConfig: string;
 *   notationCache: string;
 *   notationLibexec: string;
 *   dockerConfig: string;
 *   temp: string;
 *   bin: string;
 * }} VerifierEnvironmentPaths
 */

/**
 * @param {VerifierEnvironmentPaths} paths
 * @param {ImageSignatureInvocation} invocation
 * @param {Record<string, string | undefined>} sourceEnvironment
 * @returns {Record<string, string> | undefined}
 */
export function buildVerifierEnvironment(paths, invocation, sourceEnvironment) {
  const credentials = selectAwsCredentialEnvironment(sourceEnvironment);
  if (!credentials) {
    return undefined;
  }
  return {
    HOME: paths.home,
    NOTATION_CONFIG: paths.notationConfig,
    NOTATION_CACHE: paths.notationCache,
    NOTATION_LIBEXEC: paths.notationLibexec,
    DOCKER_CONFIG: paths.dockerConfig,
    TMPDIR: paths.temp,
    PATH: paths.bin,
    AWS_REGION: invocation.imageRegion,
    AWS_DEFAULT_REGION: invocation.imageRegion,
    AWS_EC2_METADATA_DISABLED: 'true',
    ...credentials,
  };
}

/**
 * @param {Uint8Array} value
 * @returns {string}
 */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isSafeRelativePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    !value.split('/').includes('..')
  );
}

/**
 * @typedef {{
 *   path: string;
 *   sha256: string;
 *   mode: '0644' | '0755';
 *   size: number;
 * }} InstalledAssetFile
 * @typedef {{
 *   notationPath: string;
 *   pluginPath: string;
 *   credentialHelperPath: string;
 *   trustRootPath: string;
 *   verifierVersion: string;
 *   assetManifestSha256: string;
 *   trustRootSha256: string;
 * }} ValidatedVerifierAssets
 */

const lambdaRuntimeCompatibleAssetModes = Object.freeze({
  '0644': new Set([0o444, 0o555, 0o644, 0o755]),
  '0755': new Set([0o555, 0o755]),
});

/**
 * Narrow compatibility boundary for Lambda's optimized, read-only ZIP
 * representation. The build artifact and installation record remain exact
 * 0644/0755 authority; only the runtime stat projection is normalized here.
 * Removing this adapter requires changing this function and its focused tests,
 * not weakening checksum, size, allowlist, or package-mode validation.
 *
 * @param {'0644' | '0755'} recordedMode
 * @param {number} actualMode
 * @returns {boolean}
 */
export function isLambdaRuntimeAssetModeCompatible(recordedMode, actualMode) {
  return (
    Number.isSafeInteger(actualMode) &&
    actualMode >= 0 &&
    actualMode <= 0o7777 &&
    (lambdaRuntimeCompatibleAssetModes[recordedMode]?.has(actualMode) ?? false)
  );
}

/**
 * @param {string} root
 * @param {string} [relativeDirectory]
 * @returns {Promise<string[]>}
 */
async function listAssetFiles(root, relativeDirectory = '') {
  const currentDirectory = path.join(root, relativeDirectory);
  const entries = await readdir(currentDirectory, { withFileTypes: true });
  /** @type {string[]} */
  const files = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
    if (entry.isSymbolicLink()) {
      throw new AssetDiagnosticError('ASSET_DIRECTORY_INVALID');
    }
    if (entry.isDirectory()) {
      files.push(...(await listAssetFiles(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new AssetDiagnosticError('ASSET_DIRECTORY_INVALID');
    }
  }
  return files.sort();
}

/**
 * @param {string} assetRoot
 * @param {'amd64' | 'arm64'} expectedArchitecture
 * @returns {Promise<ValidatedVerifierAssets>}
 */
async function validateVerifierAssets(assetRoot, expectedArchitecture) {
  const manifestPath = path.join(assetRoot, 'asset-manifest.json');
  const installationPath = path.join(assetRoot, 'installation.json');
  const [manifestRaw, installationRaw] = await Promise.all([readFile(manifestPath), readFile(installationPath)]);
  let manifest;
  let installation;
  try {
    manifest = JSON.parse(manifestRaw.toString('utf8'));
    installation = JSON.parse(installationRaw.toString('utf8'));
  } catch {
    throw new AssetDiagnosticError('ASSET_METADATA_INVALID');
  }
  if (
    !isRecord(manifest) ||
    manifest['kind'] !== 'image-signature-verifier-assets' ||
    manifest['verifierVersion'] !== verifierVersion ||
    !isRecord(manifest['platforms']) ||
    !isRecord(installation) ||
    installation['kind'] !== 'image-signature-verifier-installation' ||
    installation['architecture'] !== expectedArchitecture ||
    installation['verifierVersion'] !== verifierVersion ||
    installation['assetManifestSha256'] !== sha256(manifestRaw) ||
    !isSha256(installation['trustRootSha256']) ||
    !Array.isArray(installation['files'])
  ) {
    throw new AssetDiagnosticError('ASSET_METADATA_INVALID');
  }

  const platform = manifest['platforms'][`linux-${expectedArchitecture}`];
  const trustRoot = manifest['trustRoot'];
  if (
    !isRecord(platform) ||
    platform['os'] !== 'linux' ||
    platform['architecture'] !== expectedArchitecture ||
    !isRecord(platform['notation']) ||
    platform['notation']['version'] !== '1.3.2' ||
    !isRecord(platform['awsSignerPlugin']) ||
    platform['awsSignerPlugin']['version'] !== '1.0.2292' ||
    !isRecord(platform['ecrCredentialHelper']) ||
    platform['ecrCredentialHelper']['version'] !== '0.12.0' ||
    !isRecord(trustRoot) ||
    trustRoot['name'] !== 'aws-signer-ts'
  ) {
    throw new AssetDiagnosticError('ASSET_METADATA_INVALID');
  }

  const notationPath = platform['notation']['installedPath'];
  const pluginPath = platform['awsSignerPlugin']['installedPath'];
  const credentialHelperPath = platform['ecrCredentialHelper']['installedPath'];
  const trustRootPath = trustRoot['installedPath'];
  const requiredAssets = [
    [notationPath, platform['notation']['executableSha256'], '0755'],
    [pluginPath, platform['awsSignerPlugin']['executableSha256'], '0755'],
    [credentialHelperPath, platform['ecrCredentialHelper']['executableSha256'], '0755'],
    [trustRootPath, trustRoot['sha256'], '0644'],
    ['asset-manifest.json', sha256(manifestRaw), '0644'],
  ];
  if (
    requiredAssets.some(
      ([relativePath, expectedSha256]) => !isSafeRelativePath(relativePath) || !isSha256(expectedSha256),
    ) ||
    installation['trustRootSha256'] !== trustRoot['sha256']
  ) {
    throw new AssetDiagnosticError('ASSET_AUTHORITY_INVALID');
  }

  /** @type {InstalledAssetFile[]} */
  const files = [];
  for (const candidate of installation['files']) {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).sort().join('\0') !== 'mode\0path\0sha256\0size' ||
      !isSafeRelativePath(candidate['path']) ||
      !isSha256(candidate['sha256']) ||
      (candidate['mode'] !== '0755' && candidate['mode'] !== '0644') ||
      !Number.isSafeInteger(candidate['size']) ||
      /** @type {number} */ (candidate['size']) < 0 ||
      /** @type {number} */ (candidate['size']) > maximumAssetBytes
    ) {
      throw new AssetDiagnosticError('ASSET_INSTALLATION_RECORD_INVALID');
    }
    files.push(
      /** @type {InstalledAssetFile} */ ({
        path: candidate['path'],
        sha256: candidate['sha256'],
        mode: candidate['mode'],
        size: candidate['size'],
      }),
    );
  }
  if (
    files.length === 0 ||
    new Set(files.map((file) => file.path)).size !== files.length ||
    files.some((file, index) => index > 0 && (files[index - 1]?.path.localeCompare(file.path) ?? -1) >= 0) ||
    files.reduce((total, file) => total + file.size, 0) > maximumAssetBytes
  ) {
    throw new AssetDiagnosticError('ASSET_INSTALLATION_RECORD_INVALID');
  }

  const actualFiles = await listAssetFiles(assetRoot);
  const expectedFiles = [...files.map((file) => file.path), 'installation.json'].sort();
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((file, index) => file !== expectedFiles[index])) {
    throw new AssetDiagnosticError('ASSET_DIRECTORY_INVALID');
  }

  for (const file of files) {
    const absolutePath = path.join(assetRoot, file.path);
    const details = await lstat(absolutePath);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new AssetDiagnosticError('ASSET_FILE_TYPE_INVALID');
    }
    if (details.size !== file.size) {
      throw new AssetDiagnosticError('ASSET_FILE_SIZE_INVALID');
    }
    if (!isLambdaRuntimeAssetModeCompatible(file.mode, details.mode & 0o7777)) {
      throw new AssetDiagnosticError('ASSET_FILE_MODE_INVALID');
    }
    if (sha256(await readFile(absolutePath)) !== file.sha256) {
      throw new AssetDiagnosticError('ASSET_FILE_HASH_INVALID');
    }
  }
  const installationDetails = await lstat(installationPath);
  if (
    !installationDetails.isFile() ||
    installationDetails.isSymbolicLink() ||
    !isLambdaRuntimeAssetModeCompatible('0644', installationDetails.mode & 0o7777)
  ) {
    throw new AssetDiagnosticError('ASSET_INSTALLATION_MODE_INVALID');
  }
  for (const [relativePath, expectedSha256, expectedMode] of requiredAssets) {
    const installed = files.find((file) => file.path === relativePath);
    if (!installed || installed.sha256 !== expectedSha256 || installed.mode !== expectedMode) {
      throw new AssetDiagnosticError('ASSET_AUTHORITY_INVALID');
    }
  }

  return {
    notationPath: path.join(assetRoot, /** @type {string} */ (notationPath)),
    pluginPath: path.join(assetRoot, /** @type {string} */ (pluginPath)),
    credentialHelperPath: path.join(assetRoot, /** @type {string} */ (credentialHelperPath)),
    trustRootPath: path.join(assetRoot, /** @type {string} */ (trustRootPath)),
    verifierVersion,
    assetManifestSha256: /** @type {string} */ (installation['assetManifestSha256']),
    trustRootSha256: /** @type {string} */ (installation['trustRootSha256']),
  };
}

/**
 * @typedef {{
 *   root: string;
 *   paths: VerifierEnvironmentPaths;
 *   trustPolicySha256: string;
 * }} InvocationWorkspace
 */

/**
 * @param {string} temporaryRoot
 * @param {ImageSignatureInvocation} invocation
 * @param {ValidatedVerifierAssets} assets
 * @returns {Promise<InvocationWorkspace>}
 */
async function createInvocationWorkspace(temporaryRoot, invocation, assets) {
  const root = await mkdtemp(path.join(temporaryRoot, 'image-signature-verifier-'));
  try {
    await chmod(root, 0o700);
    /** @type {VerifierEnvironmentPaths} */
    const paths = {
      home: path.join(root, 'home'),
      notationConfig: path.join(root, 'config'),
      notationCache: path.join(root, 'cache'),
      notationLibexec: path.join(root, 'libexec'),
      dockerConfig: path.join(root, 'docker'),
      temp: path.join(root, 'tmp'),
      bin: path.dirname(assets.notationPath),
    };
    for (const directory of [
      paths.home,
      paths.notationConfig,
      paths.notationCache,
      paths.notationLibexec,
      paths.dockerConfig,
      paths.temp,
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }

    const pluginDestination = path.join(
      paths.notationLibexec,
      'plugins/com.amazonaws.signer.notation.plugin/notation-com.amazonaws.signer.notation.plugin',
    );
    const trustRootDestination = path.join(
      paths.notationConfig,
      'truststore/x509/signingAuthority/aws-signer-ts/aws-signer-notation-root.cert',
    );
    for (const parent of [path.dirname(pluginDestination), path.dirname(trustRootDestination)]) {
      await mkdir(parent, { recursive: true, mode: 0o700 });
      let current = parent;
      while (current.startsWith(root) && current !== root) {
        await chmod(current, 0o700);
        current = path.dirname(current);
      }
    }
    await Promise.all([
      copyFile(assets.pluginPath, pluginDestination),
      copyFile(assets.trustRootPath, trustRootDestination),
    ]);
    await Promise.all([chmod(pluginDestination, 0o500), chmod(trustRootDestination, 0o400)]);

    const registryHost = `${invocation.registryId}.dkr.ecr.${invocation.imageRegion}.amazonaws.com`;
    const trustPolicy = {
      version: '1.0',
      trustPolicies: [
        {
          name: 'aws-signer',
          registryScopes: [`${registryHost}/${invocation.repositoryName}`],
          signatureVerification: { level: 'strict' },
          trustStores: ['signingAuthority:aws-signer-ts'],
          trustedIdentities: [invocation.signingProfileArn],
        },
      ],
    };
    const trustPolicyRaw = Buffer.from(`${JSON.stringify(trustPolicy, null, 2)}\n`);
    const dockerConfigRaw = Buffer.from(
      `${JSON.stringify(
        {
          credHelpers: {
            [registryHost]: 'ecr-login',
          },
        },
        null,
        2,
      )}\n`,
    );
    const trustPolicyPath = path.join(paths.notationConfig, 'trustpolicy.json');
    const dockerConfigPath = path.join(paths.dockerConfig, 'config.json');
    await Promise.all([
      writeFile(trustPolicyPath, trustPolicyRaw, { mode: 0o600 }),
      writeFile(dockerConfigPath, dockerConfigRaw, { mode: 0o600 }),
    ]);
    await Promise.all([chmod(trustPolicyPath, 0o600), chmod(dockerConfigPath, 0o600)]);

    return {
      root,
      paths,
      trustPolicySha256: sha256(trustPolicyRaw),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/**
 * @typedef {{
 *   executable: string;
 *   args: readonly string[];
 *   environment: Record<string, string>;
 *   timeoutMs: number;
 *   maxBuffer: number;
 * }} NotationProcessRequest
 * @typedef {{
 *   kind: 'success' | 'exit' | 'timeout' | 'spawn_error' | 'signal' | 'wrapper_error'
 * }} NotationProcessResult
 */

/**
 * @param {NotationProcessRequest} request
 * @returns {Promise<NotationProcessResult>}
 */
export function runNotationProcess(request) {
  return new Promise((resolve) => {
    execFile(
      request.executable,
      [...request.args],
      {
        encoding: 'buffer',
        env: request.environment,
        killSignal: 'SIGKILL',
        maxBuffer: request.maxBuffer,
        shell: false,
        timeout: request.timeoutMs,
        windowsHide: true,
      },
      (error) => {
        if (!error) {
          resolve({ kind: 'success' });
          return;
        }
        const processError = /** @type {NodeJS.ErrnoException & { killed?: boolean; signal?: string }} */ (error);
        if (processError.killed === true || processError.signal === 'SIGKILL' || processError.code === 'ETIMEDOUT') {
          resolve({ kind: 'timeout' });
          return;
        }
        if (typeof processError.code === 'number') {
          resolve({ kind: 'exit' });
          return;
        }
        if (typeof processError.signal === 'string') {
          resolve({ kind: 'signal' });
          return;
        }
        if (typeof processError.code === 'string' && spawnErrorCodes.has(processError.code)) {
          resolve({ kind: 'spawn_error' });
          return;
        }
        resolve({ kind: 'wrapper_error' });
      },
    );
  });
}

/**
 * @typedef {'VERIFIED' | 'VERIFICATION_FAILED' | 'VERIFIER_TIMEOUT' | 'VERIFIER_ERROR'} VerificationResultName
 * @typedef {{
 *   result: 'VERIFIED';
 *   mode: 'cryptographic';
 *   verifierVersion: string;
 *   verifierAssets: {
 *     notationVersion: '1.3.2';
 *     awsSignerPluginVersion: '1.0.2292';
 *     ecrCredentialHelperVersion: '0.12.0';
 *     trustRootSha256: string;
 *   };
 *   trustPolicySha256: string;
 *   assetManifestSha256: string;
 * } | {
 *   result: Exclude<VerificationResultName, 'VERIFIED'>;
 *   mode: 'cryptographic';
 *   reasonCode: string;
 * }} ImageVerificationResult
 */

/**
 * @param {Exclude<VerificationResultName, 'VERIFIED'>} result
 * @param {string} reasonCode
 * @returns {ImageVerificationResult}
 */
function boundedFailure(result, reasonCode) {
  return { result, mode: 'cryptographic', reasonCode };
}

/**
 * @typedef {{
 *   assetRoot: string;
 *   temporaryRoot: string;
 *   expectedArchitecture: 'amd64' | 'arm64';
 *   sourceEnvironment: Record<string, string | undefined>;
 *   maxStatusAttempts: number;
 *   statusAttemptTimeoutMs: number;
 *   statusRetryDelayMs: number;
 *   verifierTimeoutMs: number;
 *   expectedAssetManifestSha256?: string;
 *   expectedTrustRootSha256?: string;
 *   describeSigningStatus: (invocation: ImageSignatureInvocation, abortSignal: AbortSignal) => Promise<unknown>;
 *   sleep?: (delayMs: number) => Promise<void>;
 *   runNotation?: (request: NotationProcessRequest) => Promise<NotationProcessResult | Record<string, unknown>>;
 * }} ImageVerifierDependencies
 */

/**
 * @param {unknown} event
 * @param {ImageVerifierDependencies} dependencies
 * @returns {Promise<ImageVerificationResult>}
 */
export async function verifyImageSignature(event, dependencies) {
  const invocation = parseImageSignatureInvocation(event);
  if (!invocation) {
    return boundedFailure('VERIFICATION_FAILED', 'INVALID_INVOCATION');
  }
  if (
    !path.isAbsolute(dependencies.assetRoot) ||
    !path.isAbsolute(dependencies.temporaryRoot) ||
    (dependencies.expectedArchitecture !== 'amd64' && dependencies.expectedArchitecture !== 'arm64') ||
    !Number.isSafeInteger(dependencies.verifierTimeoutMs) ||
    dependencies.verifierTimeoutMs < 1 ||
    dependencies.verifierTimeoutMs > 60_000 ||
    (dependencies.expectedAssetManifestSha256 !== undefined && !isSha256(dependencies.expectedAssetManifestSha256)) ||
    (dependencies.expectedTrustRootSha256 !== undefined && !isSha256(dependencies.expectedTrustRootSha256))
  ) {
    return boundedFailure('VERIFIER_ERROR', 'VERIFIER_CONTRACT_ERROR');
  }
  const credentialEnvironment = selectAwsCredentialEnvironment(dependencies.sourceEnvironment);
  if (!credentialEnvironment) {
    return boundedFailure('VERIFIER_ERROR', 'CREDENTIAL_SOURCE_INVALID');
  }

  const readiness = await pollSigningReadiness(invocation, {
    maxAttempts: dependencies.maxStatusAttempts,
    attemptTimeoutMs: dependencies.statusAttemptTimeoutMs,
    retryDelayMs: dependencies.statusRetryDelayMs,
    describeSigningStatus: dependencies.describeSigningStatus,
    ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
  });
  if (readiness.kind === 'failed') {
    return boundedFailure('VERIFICATION_FAILED', readiness.reasonCode);
  }
  if (readiness.kind === 'error') {
    return boundedFailure('VERIFIER_ERROR', readiness.reasonCode);
  }

  let assets;
  try {
    assets = await validateVerifierAssets(dependencies.assetRoot, dependencies.expectedArchitecture);
  } catch (error) {
    return boundedFailure('VERIFIER_ERROR', assetDiagnosticReason(error));
  }
  if (
    (dependencies.expectedAssetManifestSha256 !== undefined &&
      assets.assetManifestSha256 !== dependencies.expectedAssetManifestSha256) ||
    (dependencies.expectedTrustRootSha256 !== undefined &&
      assets.trustRootSha256 !== dependencies.expectedTrustRootSha256)
  ) {
    return boundedFailure('VERIFIER_ERROR', 'ASSET_DEPLOYMENT_AUTHORITY_MISMATCH');
  }

  /** @type {InvocationWorkspace | undefined} */
  let workspace;
  try {
    workspace = await createInvocationWorkspace(dependencies.temporaryRoot, invocation, assets);
    const environment = buildVerifierEnvironment(workspace.paths, invocation, dependencies.sourceEnvironment);
    if (!environment) {
      return boundedFailure('VERIFIER_ERROR', 'CREDENTIAL_SOURCE_INVALID');
    }
    const runNotation = dependencies.runNotation ?? runNotationProcess;
    let processResult;
    try {
      processResult = await runNotation({
        executable: assets.notationPath,
        args: ['verify', invocation.imageUri],
        environment,
        timeoutMs: dependencies.verifierTimeoutMs,
        maxBuffer: 65_536,
      });
    } catch {
      return boundedFailure('VERIFIER_ERROR', 'CRYPTOGRAPHIC_VERIFIER_WRAPPER_ERROR');
    }
    switch (processResult.kind) {
      case 'success':
        return {
          result: 'VERIFIED',
          mode: 'cryptographic',
          verifierVersion: assets.verifierVersion,
          verifierAssets: {
            notationVersion: '1.3.2',
            awsSignerPluginVersion: '1.0.2292',
            ecrCredentialHelperVersion: '0.12.0',
            trustRootSha256: assets.trustRootSha256,
          },
          trustPolicySha256: workspace.trustPolicySha256,
          assetManifestSha256: assets.assetManifestSha256,
        };
      case 'exit':
        return boundedFailure('VERIFICATION_FAILED', 'CRYPTOGRAPHIC_VERIFICATION_FAILED');
      case 'timeout':
        return boundedFailure('VERIFIER_TIMEOUT', 'CRYPTOGRAPHIC_VERIFIER_TIMEOUT');
      case 'spawn_error':
        return boundedFailure('VERIFIER_ERROR', 'CRYPTOGRAPHIC_VERIFIER_SPAWN_ERROR');
      case 'signal':
        return boundedFailure('VERIFIER_ERROR', 'CRYPTOGRAPHIC_VERIFIER_SIGNAL');
      case 'wrapper_error':
        return boundedFailure('VERIFIER_ERROR', 'CRYPTOGRAPHIC_VERIFIER_WRAPPER_ERROR');
      default:
        return boundedFailure('VERIFIER_ERROR', 'CRYPTOGRAPHIC_VERIFIER_RESULT_INVALID');
    }
  } catch {
    return boundedFailure('VERIFIER_ERROR', 'RUNTIME_SETUP_ERROR');
  } finally {
    if (workspace) {
      await rm(workspace.root, { recursive: true, force: true });
    }
  }
}
