import { sha256, isRecord, isSafeRelativePath, isSha256 } from '../../infra/image-signature-verifier/asset-files.mjs';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const supportedArchitectures = new Set(['amd64', 'arm64']);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultManifestPath = path.join(repoRoot, 'infra/image-signature-verifier/asset-manifest.json');
const maxDownloadBytes = 64 * 1024 * 1024;
const maxCommandOutputBytes = 64 * 1024 * 1024;

/**
 * @typedef {'amd64' | 'arm64'} VerifierArchitecture
 * @typedef {{
 *   architecture: VerifierArchitecture;
 *   outputDirectory: string;
 * }} InstallerArguments
 */

/**
 * @param {readonly string[]} argv
 * @returns {InstallerArguments}
 */
export function parseInstallerArguments(argv) {
  if (
    argv.length !== 4 ||
    argv[0] !== '--architecture' ||
    !supportedArchitectures.has(argv[1] ?? '') ||
    argv[2] !== '--output' ||
    typeof argv[3] !== 'string' ||
    argv[3].length === 0
  ) {
    throw new Error('Invalid image signature verifier installer arguments.');
  }

  const outputDirectory = path.resolve(argv[3]);
  const filesystemRoot = path.parse(outputDirectory).root;
  if (outputDirectory === filesystemRoot || outputDirectory === process.cwd()) {
    throw new Error('Invalid image signature verifier installer arguments.');
  }

  return {
    architecture: /** @type {VerifierArchitecture} */ (argv[1]),
    outputDirectory,
  };
}

/**
 * @param {readonly string[]} actual
 * @param {readonly string[]} expected
 */
export function assertExactArchiveEntries(actual, expected) {
  const normalizedActual = [...actual].sort();
  const normalizedExpected = [...expected].sort();
  if (
    new Set(actual).size !== actual.length ||
    normalizedActual.length !== normalizedExpected.length ||
    normalizedActual.some((entry, index) => entry !== normalizedExpected[index])
  ) {
    throw new Error('Downloaded verifier archive contents do not match the allowlist.');
  }
}

/**
 * @param {Uint8Array} executable
 * @param {number} expectedMachine
 */
export function assertElfArchitecture(executable, expectedMachine) {
  if (
    executable.byteLength < 20 ||
    executable[0] !== 0x7f ||
    executable[1] !== 0x45 ||
    executable[2] !== 0x4c ||
    executable[3] !== 0x46 ||
    executable[4] !== 2 ||
    executable[5] !== 1
  ) {
    throw new Error('Verifier executable is not a supported 64-bit little-endian ELF file.');
  }
  const actualMachine = (executable[18] ?? -1) | ((executable[19] ?? -1) << 8);
  if (actualMachine !== expectedMachine) {
    throw new Error('Verifier executable architecture does not match the selected platform.');
  }
}

/**
 * @typedef {{
 *   path: string;
 *   sha256: string;
 *   mode: string;
 *   size: number;
 * }} InstalledFile
 */

/**
 * @typedef {{
 *   architecture: VerifierArchitecture;
 *   verifierVersion: string;
 *   assetManifestSha256: string;
 *   trustRootSha256: string;
 *   files: readonly InstalledFile[];
 * }} InstallationRecordInput
 */

/**
 * @param {InstallationRecordInput} input
 */
export function buildInstallationRecord(input) {
  return {
    kind: 'image-signature-verifier-installation',
    architecture: input.architecture,
    verifierVersion: input.verifierVersion,
    assetManifestSha256: input.assetManifestSha256,
    trustRootSha256: input.trustRootSha256,
    files: [...input.files],
  };
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isPinnedHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) {
    return false;
  }
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
function isArchiveEntryList(value) {
  return (
    Array.isArray(value) && value.length > 0 && value.every(isSafeRelativePath) && new Set(value).size === value.length
  );
}

/**
 * @param {unknown} value
 * @param {string} expectedVersion
 * @param {boolean} archived
 * @returns {value is Record<string, unknown>}
 */
function isExecutableAsset(value, expectedVersion, archived) {
  if (
    !isRecord(value) ||
    value['version'] !== expectedVersion ||
    !isPinnedHttpsUrl(value['url']) ||
    !isSha256(value['executableSha256']) ||
    !isSafeRelativePath(value['installedPath'])
  ) {
    return false;
  }
  if (!archived) {
    return value['archiveSha256'] === undefined && value['archiveEntries'] === undefined;
  }
  return isArchivedExecutable(value);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isCredentialHelperAsset(value) {
  if (!isExecutableAsset(value, '0.12.0', false)) {
    return false;
  }
  const licenseUrl = value['licenseUrl'];
  const noticeUrl = value['noticeUrl'];
  if (
    !isPinnedHttpsUrl(licenseUrl) ||
    !isSha256(value['licenseSha256']) ||
    !isPinnedHttpsUrl(noticeUrl) ||
    !isSha256(value['noticeSha256'])
  ) {
    return false;
  }
  const pinnedSourcePath = '/awslabs/amazon-ecr-credential-helper/7ff7d6bd7a06408ddb9646c9ebccf97dbd190d55/';
  return (
    new URL(licenseUrl).hostname === 'raw.githubusercontent.com' &&
    new URL(licenseUrl).pathname === `${pinnedSourcePath}LICENSE` &&
    new URL(noticeUrl).hostname === 'raw.githubusercontent.com' &&
    new URL(noticeUrl).pathname === `${pinnedSourcePath}NOTICE`
  );
}

/**
 * @param {Buffer} raw
 * @param {VerifierArchitecture} architecture
 * @returns {{
 *   manifest: Record<string, unknown>;
 *   platform: Record<string, unknown>;
 *   trustRoot: Record<string, unknown>;
 * }}
 */
function parseAssetManifest(raw, architecture) {
  const { manifest, platforms } = parseManifestEnvelope(raw);

  const platform = admitInstallPlatform(platforms[`linux-${architecture}`], architecture);

  const notation = /** @type {Record<string, unknown>} */ (platform['notation']);
  const plugin = /** @type {Record<string, unknown>} */ (platform['awsSignerPlugin']);
  const helper = /** @type {Record<string, unknown>} */ (platform['ecrCredentialHelper']);
  assertExecutableDownloadPins(notation, plugin, helper);

  const trustRoot = admitInstallTrustRoot(manifest['trustRoot']);

  const installedPaths = [
    notation['installedPath'],
    plugin['installedPath'],
    helper['installedPath'],
    trustRoot['installedPath'],
  ];
  if (new Set(installedPaths).size !== installedPaths.length) {
    throw new Error('Image signature verifier asset manifest is invalid.');
  }
  return { manifest, platform, trustRoot };
}

/**
 * @param {string} url
 * @param {string} destination
 */
async function defaultDownloadToFile(url, destination) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error('Verifier asset download failed.');
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > maxDownloadBytes) {
    throw new Error('Verifier asset download exceeded the size limit.');
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0 || body.length > maxDownloadBytes) {
    throw new Error('Verifier asset download exceeded the size limit.');
  }
  await writeFile(destination, body, { mode: 0o600 });
}

/**
 * @param {string} executable
 * @param {readonly string[]} args
 * @returns {Promise<Buffer>}
 */
function execFileBuffer(executable, args) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        encoding: 'buffer',
        maxBuffer: maxCommandOutputBytes,
        timeout: 30_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error('Verifier asset archive inspection failed.'));
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

/**
 * @param {string} archivePath
 * @returns {Promise<string[]>}
 */
async function defaultListTarGzipEntries(archivePath) {
  const output = await execFileBuffer('tar', ['-tzf', archivePath]);
  return output
    .toString('utf8')
    .split(/\r?\n/)
    .filter((entry) => entry.length > 0);
}

/**
 * @param {string} archivePath
 * @param {string} entry
 * @returns {Promise<Buffer>}
 */
async function defaultExtractTarGzipEntry(archivePath, entry) {
  return await execFileBuffer('tar', ['-xOzf', archivePath, entry]);
}

/**
 * @param {string} archivePath
 * @returns {Promise<string[]>}
 */
async function defaultListZipEntries(archivePath) {
  const output = await execFileBuffer('unzip', ['-Z1', archivePath]);
  return output
    .toString('utf8')
    .split(/\r?\n/)
    .filter((entry) => entry.length > 0);
}

/**
 * @param {string} archivePath
 * @param {string} entry
 * @returns {Promise<Buffer>}
 */
async function defaultExtractZipEntry(archivePath, entry) {
  return await execFileBuffer('unzip', ['-p', archivePath, entry]);
}

/**
 * @param {string} executable
 * @param {readonly string[]} args
 * @param {Record<string, string>} environment
 * @returns {Promise<string>}
 */
function execFileText(executable, args, environment) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        encoding: 'utf8',
        env: environment,
        maxBuffer: 64 * 1024,
        timeout: 10_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error('Native verifier asset load check failed.'));
          return;
        }
        resolve(typeof stdout === 'string' ? stdout : String(stdout));
      },
    );
  });
}

/**
 * @param {string} assetRoot
 * @param {Record<string, unknown>} platform
 */
async function defaultRunNativeChecks(assetRoot, platform) {
  const expectedArchitecture = platform['architecture'];
  const nativeArchitecture = process.arch === 'x64' ? 'amd64' : process.arch;
  if (process.platform !== 'linux' || nativeArchitecture !== expectedArchitecture) {
    throw new Error('Native verifier asset load check requires a matching Linux architecture.');
  }

  const notation = /** @type {Record<string, unknown>} */ (platform['notation']);
  const plugin = /** @type {Record<string, unknown>} */ (platform['awsSignerPlugin']);
  const helper = /** @type {Record<string, unknown>} */ (platform['ecrCredentialHelper']);
  const checkRoot = path.join(assetRoot, '.native-check');
  const environment = {
    HOME: path.join(checkRoot, 'home'),
    NOTATION_CONFIG: path.join(checkRoot, 'config'),
    NOTATION_CACHE: path.join(checkRoot, 'cache'),
    NOTATION_LIBEXEC: path.join(assetRoot, 'libexec'),
    PATH: path.join(assetRoot, 'bin'),
    AWS_EC2_METADATA_DISABLED: 'true',
  };
  try {
    for (const directory of [checkRoot, environment.HOME, environment.NOTATION_CONFIG, environment.NOTATION_CACHE]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    const notationOutput = await execFileText(
      path.join(assetRoot, /** @type {string} */ (notation['installedPath'])),
      ['version'],
      environment,
    );
    const helperOutput = await execFileText(
      path.join(assetRoot, /** @type {string} */ (helper['installedPath'])),
      ['-v'],
      environment,
    );
    const pluginOutput = await execFileText(
      path.join(assetRoot, /** @type {string} */ (notation['installedPath'])),
      ['plugin', 'ls'],
      environment,
    );
    if (
      !/\bVersion:\s+1\.3\.2\b/.test(notationOutput) ||
      !/\bVersion:\s+0\.12\.0\b/.test(helperOutput) ||
      !pluginOutput.includes('com.amazonaws.signer.notation.plugin') ||
      !pluginOutput.includes(/** @type {string} */ (plugin['version']))
    ) {
      throw new Error('Native verifier asset version check failed.');
    }
  } finally {
    await rm(checkRoot, { recursive: true, force: true });
  }
}

/**
 * @param {string} outputDirectory
 */
async function assertOutputDoesNotExist(outputDirectory) {
  const filesystemRoot = path.parse(outputDirectory).root;
  if (outputDirectory === filesystemRoot || outputDirectory === process.cwd()) {
    throw new Error('Image signature verifier output directory is unsafe.');
  }
  try {
    await lstat(outputDirectory);
  } catch (error) {
    if (isRecord(error) && error['code'] === 'ENOENT') {
      return;
    }
    throw error;
  }
  throw new Error('Image signature verifier output directory already exists.');
}

/**
 * @param {string} assetRoot
 * @param {string} relativePath
 * @param {Uint8Array} contents
 * @param {number} mode
 * @returns {Promise<InstalledFile>}
 */
async function writeInstalledFile(assetRoot, relativePath, contents, mode) {
  if (!isSafeRelativePath(relativePath)) {
    throw new Error('Image signature verifier installed path is invalid.');
  }
  const destination = path.join(assetRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, contents, { mode });
  await chmod(destination, mode);
  return {
    path: relativePath,
    sha256: sha256(contents),
    mode: mode.toString(8).padStart(4, '0'),
    size: contents.byteLength,
  };
}

/**
 * @typedef {{
 *   downloadToFile: (url: string, destination: string) => Promise<void>;
 *   listTarGzipEntries: (archivePath: string) => Promise<string[]>;
 *   extractTarGzipEntry: (archivePath: string, entry: string) => Promise<Buffer>;
 *   listZipEntries: (archivePath: string) => Promise<string[]>;
 *   extractZipEntry: (archivePath: string, entry: string) => Promise<Buffer>;
 *   runNativeChecks: (assetRoot: string, platform: Record<string, unknown>) => Promise<void>;
 * }} InstallerDependencies
 */

/**
 * @typedef {{
 *   architecture: VerifierArchitecture;
 *   outputDirectory: string;
 *   manifestPath?: string;
 *   dependencies?: Partial<InstallerDependencies>;
 * }} InstallOptions
 */

/**
 * @param {InstallOptions} options
 */
export async function installImageSignatureVerifierAssets(options) {
  const outputDirectory = path.resolve(options.outputDirectory);
  await assertOutputDoesNotExist(outputDirectory);
  const manifestPath = path.resolve(options.manifestPath ?? defaultManifestPath);
  const manifestRaw = await readFile(manifestPath);
  const { manifest, platform, trustRoot } = parseAssetManifest(manifestRaw, options.architecture);
  const dependencies = {
    downloadToFile: defaultDownloadToFile,
    listTarGzipEntries: defaultListTarGzipEntries,
    extractTarGzipEntry: defaultExtractTarGzipEntry,
    listZipEntries: defaultListZipEntries,
    extractZipEntry: defaultExtractZipEntry,
    runNativeChecks: defaultRunNativeChecks,
    ...options.dependencies,
  };

  await mkdir(path.dirname(outputDirectory), { recursive: true, mode: 0o700 });
  const stagingRoot = await mkdtemp(path.join(path.dirname(outputDirectory), '.image-signature-verifier-'));
  await chmod(stagingRoot, 0o700);
  let published = false;
  try {
    const downloadRoot = path.join(stagingRoot, '.downloads');
    await mkdir(downloadRoot, { mode: 0o700 });
    const notationArchivePath = path.join(downloadRoot, 'notation.tar.gz');
    const pluginArchivePath = path.join(downloadRoot, 'plugin.zip');
    const helperDownloadPath = path.join(downloadRoot, 'docker-credential-ecr-login');
    const helperLicenseDownloadPath = path.join(downloadRoot, 'ecr-credential-helper-LICENSE');
    const helperNoticeDownloadPath = path.join(downloadRoot, 'ecr-credential-helper-NOTICE');
    const trustRootDownloadPath = path.join(downloadRoot, 'aws-signer-notation-root.cert');
    const notation = /** @type {Record<string, unknown>} */ (platform['notation']);
    const plugin = /** @type {Record<string, unknown>} */ (platform['awsSignerPlugin']);
    const helper = /** @type {Record<string, unknown>} */ (platform['ecrCredentialHelper']);

    await Promise.all([
      dependencies.downloadToFile(/** @type {string} */ (notation['url']), notationArchivePath),
      dependencies.downloadToFile(/** @type {string} */ (plugin['url']), pluginArchivePath),
      dependencies.downloadToFile(/** @type {string} */ (helper['url']), helperDownloadPath),
      dependencies.downloadToFile(/** @type {string} */ (helper['licenseUrl']), helperLicenseDownloadPath),
      dependencies.downloadToFile(/** @type {string} */ (helper['noticeUrl']), helperNoticeDownloadPath),
      dependencies.downloadToFile(/** @type {string} */ (trustRoot['url']), trustRootDownloadPath),
    ]);
    const [notationArchive, pluginArchive, helperExecutable, helperLicense, helperNotice, trustRootContents] =
      await Promise.all([
        readFile(notationArchivePath),
        readFile(pluginArchivePath),
        readFile(helperDownloadPath),
        readFile(helperLicenseDownloadPath),
        readFile(helperNoticeDownloadPath),
        readFile(trustRootDownloadPath),
      ]);
    for (const [contents, expected] of [
      [notationArchive, notation['archiveSha256']],
      [pluginArchive, plugin['archiveSha256']],
      [helperExecutable, helper['executableSha256']],
      [helperLicense, helper['licenseSha256']],
      [helperNotice, helper['noticeSha256']],
      [trustRootContents, trustRoot['sha256']],
    ]) {
      if (sha256(/** @type {Uint8Array} */ (contents)) !== expected) {
        throw new Error('Downloaded verifier asset checksum does not match the manifest.');
      }
    }

    const [notationEntries, pluginEntries] = await Promise.all([
      dependencies.listTarGzipEntries(notationArchivePath),
      dependencies.listZipEntries(pluginArchivePath),
    ]);
    assertExactArchiveEntries(notationEntries, /** @type {string[]} */ (notation['archiveEntries']));
    assertExactArchiveEntries(pluginEntries, /** @type {string[]} */ (plugin['archiveEntries']));

    const [notationExecutable, notationLicense, pluginExecutable, pluginLicense, pluginNotices] = await Promise.all([
      dependencies.extractTarGzipEntry(notationArchivePath, /** @type {string} */ (notation['executableEntry'])),
      dependencies.extractTarGzipEntry(notationArchivePath, 'LICENSE'),
      dependencies.extractZipEntry(pluginArchivePath, /** @type {string} */ (plugin['executableEntry'])),
      dependencies.extractZipEntry(pluginArchivePath, 'LICENSE'),
      dependencies.extractZipEntry(pluginArchivePath, 'THIRD_PARTY_LICENSES'),
    ]);
    for (const [contents, expectedSha256] of [
      [notationExecutable, notation['executableSha256']],
      [pluginExecutable, plugin['executableSha256']],
    ]) {
      if (sha256(/** @type {Uint8Array} */ (contents)) !== expectedSha256) {
        throw new Error('Extracted verifier executable checksum does not match the manifest.');
      }
      assertElfArchitecture(/** @type {Uint8Array} */ (contents), /** @type {number} */ (platform['elfMachine']));
    }
    assertElfArchitecture(helperExecutable, /** @type {number} */ (platform['elfMachine']));

    /** @type {InstalledFile[]} */
    const files = [];
    for (const [relativePath, contents, mode] of [
      [notation['installedPath'], notationExecutable, 0o755],
      [plugin['installedPath'], pluginExecutable, 0o755],
      [helper['installedPath'], helperExecutable, 0o755],
      [trustRoot['installedPath'], trustRootContents, 0o644],
      ['licenses/notation-LICENSE', notationLicense, 0o644],
      ['licenses/aws-signer-plugin-LICENSE', pluginLicense, 0o644],
      ['licenses/aws-signer-plugin-THIRD_PARTY_LICENSES', pluginNotices, 0o644],
      ['licenses/ecr-credential-helper-LICENSE', helperLicense, 0o644],
      ['licenses/ecr-credential-helper-NOTICE', helperNotice, 0o644],
      ['asset-manifest.json', manifestRaw, 0o644],
    ]) {
      files.push(
        await writeInstalledFile(
          stagingRoot,
          /** @type {string} */ (relativePath),
          /** @type {Uint8Array} */ (contents),
          /** @type {number} */ (mode),
        ),
      );
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    await rm(downloadRoot, { recursive: true, force: true });
    await dependencies.runNativeChecks(stagingRoot, platform);

    const installation = buildInstallationRecord({
      architecture: options.architecture,
      verifierVersion: /** @type {string} */ (manifest['verifierVersion']),
      assetManifestSha256: sha256(manifestRaw),
      trustRootSha256: /** @type {string} */ (trustRoot['sha256']),
      files,
    });
    await writeInstalledFile(
      stagingRoot,
      'installation.json',
      Buffer.from(`${JSON.stringify(installation, null, 2)}\n`),
      0o644,
    );
    await rename(stagingRoot, outputDirectory);
    published = true;
    return installation;
  } finally {
    if (!published) {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }
}

async function main() {
  try {
    const args = parseInstallerArguments(process.argv.slice(2));
    const installation = await installImageSignatureVerifierAssets(args);
    process.stdout.write(
      `${JSON.stringify({
        kind: installation.kind,
        architecture: installation.architecture,
        verifierVersion: installation.verifierVersion,
        assetManifestSha256: installation.assetManifestSha256,
        trustRootSha256: installation.trustRootSha256,
      })}\n`,
    );
  } catch {
    process.stderr.write('Image signature verifier asset installation failed.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

/** @param {Record<string,unknown>} value */
function isArchivedExecutable(value) {
  return (
    isSha256(value['archiveSha256']) &&
    isArchiveEntryList(value['archiveEntries']) &&
    typeof value['executableEntry'] === 'string' &&
    value['archiveEntries'].includes(value['executableEntry'])
  );
}

/** @param {Buffer} raw */
function parseManifestEnvelope(raw) {
  let manifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('Image signature verifier asset manifest is invalid.');
  }
  if (
    !isRecord(manifest) ||
    manifest['kind'] !== 'image-signature-verifier-assets' ||
    manifest['verifierVersion'] !== 'notation@1.3.2+aws-signer-plugin@1.0.2292' ||
    !isRecord(manifest['platforms'])
  ) {
    throw new Error('Image signature verifier asset manifest is invalid.');
  }

  return { manifest, platforms: manifest['platforms'] };
}

/** @param {unknown} value @param {VerifierArchitecture} architecture */
function admitInstallPlatform(value, architecture) {
  const platform = value;
  const expectedMachine = architecture === 'amd64' ? 62 : 183;
  if (
    !isRecord(platform) ||
    platform['os'] !== 'linux' ||
    platform['architecture'] !== architecture ||
    platform['elfMachine'] !== expectedMachine ||
    !isExecutableAsset(platform['notation'], '1.3.2', true) ||
    !isExecutableAsset(platform['awsSignerPlugin'], '1.0.2292', true) ||
    !isCredentialHelperAsset(platform['ecrCredentialHelper'])
  ) {
    throw new Error('Image signature verifier asset manifest is invalid.');
  }

  return platform;
}

/** @param {Record<string,unknown>} notation @param {Record<string,unknown>} plugin @param {Record<string,unknown>} helper */
function assertExecutableDownloadPins(notation, plugin, helper) {
  const notationUrl = new URL(/** @type {string} */ (notation['url']));
  const pluginUrl = new URL(/** @type {string} */ (plugin['url']));
  const helperUrl = new URL(/** @type {string} */ (helper['url']));
  if (
    !notationUrl.pathname.includes('/releases/download/v1.3.2/') ||
    !pluginUrl.searchParams.has('versionId') ||
    !helperUrl.pathname.includes('/0.12.0/')
  ) {
    throw new Error('Image signature verifier asset manifest is invalid.');
  }
}

/** @param {unknown} value */
function admitInstallTrustRoot(value) {
  const trustRoot = value;
  if (
    !isRecord(trustRoot) ||
    trustRoot['name'] !== 'aws-signer-ts' ||
    !isPinnedHttpsUrl(trustRoot['url']) ||
    !new URL(/** @type {string} */ (trustRoot['url'])).searchParams.has('versionId') ||
    !isSha256(trustRoot['sha256']) ||
    !isSafeRelativePath(trustRoot['installedPath'])
  ) {
    throw new Error('Image signature verifier asset manifest is invalid.');
  }

  return trustRoot;
}
