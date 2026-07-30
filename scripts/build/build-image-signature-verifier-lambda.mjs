import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yazl from 'yazl';
import { installImageSignatureVerifierAssets } from './install-image-signature-verifier-assets.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const handlerEntry = path.join(repoRoot, 'infra/lambdas/image-signature-verifier/index.mjs');
const legalNoticeFiles = [
  {
    source: path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'),
    destination: 'THIRD_PARTY_NOTICES.md',
  },
  {
    source: path.join(repoRoot, 'docs/licenses/pnpm-licenses-prod.csv'),
    destination: 'licenses/pnpm-licenses-prod.csv',
  },
  {
    source: path.join(repoRoot, 'docs/licenses/pnpm-licenses-prod.json'),
    destination: 'licenses/pnpm-licenses-prod.json',
  },
];
const maximumUncompressedBytes = 200 * 1024 * 1024;
const maximumCompressedBytes = 50 * 1024 * 1024;
const maximumPackageEntries = 32;

/**
 * @param {readonly string[]} argv
 * @returns {{ platform: 'linux-amd64'; outputDirectory: string }}
 */
export function parseBuilderArguments(argv) {
  if (
    argv.length !== 4 ||
    argv[0] !== '--platform' ||
    argv[1] !== 'linux-amd64' ||
    argv[2] !== '--output' ||
    typeof argv[3] !== 'string' ||
    argv[3].length === 0
  ) {
    throw new Error('Invalid image signature verifier Lambda builder arguments.');
  }
  const outputDirectory = path.resolve(argv[3]);
  if (outputDirectory === path.parse(outputDirectory).root || outputDirectory === process.cwd()) {
    throw new Error('Invalid image signature verifier Lambda builder arguments.');
  }
  return { platform: 'linux-amd64', outputDirectory };
}

/**
 * @param {Uint8Array} value
 */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

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
 * @param {string} root
 * @param {string} [relativeDirectory]
 * @returns {Promise<string[]>}
 */
async function listFiles(root, relativeDirectory = '') {
  const entries = await readdir(path.join(root, relativeDirectory), {
    withFileTypes: true,
  });
  /** @type {string[]} */
  const files = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error('Verifier asset package contains a symbolic link.');
    }
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error('Verifier asset package contains an unsupported entry.');
    }
  }
  return files.sort();
}

/**
 * @typedef {{
 *   path: string;
 *   sha256: string;
 *   mode: '0644' | '0755';
 *   size: number;
 * }} PackageAssetFile
 * @typedef {{
 *   verifierVersion: string;
 *   assetManifestSha256: string;
 *   trustRootSha256: string;
 *   files: PackageAssetFile[];
 * }} PackageAssets
 */

/**
 * @param {string} assetRoot
 * @returns {Promise<PackageAssets>}
 */
async function validatePackageAssets(assetRoot) {
  let installation;
  try {
    installation = JSON.parse(await readFile(path.join(assetRoot, 'installation.json'), 'utf8'));
  } catch {
    throw new Error('Verifier asset installation metadata is invalid.');
  }
  if (
    !isRecord(installation) ||
    installation['kind'] !== 'image-signature-verifier-installation' ||
    installation['architecture'] !== 'amd64' ||
    installation['verifierVersion'] !== 'notation@1.3.2+aws-signer-plugin@1.0.2292' ||
    typeof installation['assetManifestSha256'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(installation['assetManifestSha256']) ||
    typeof installation['trustRootSha256'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(installation['trustRootSha256']) ||
    !Array.isArray(installation['files'])
  ) {
    throw new Error('Verifier asset installation metadata is invalid.');
  }

  /** @type {PackageAssetFile[]} */
  const files = [];
  for (const candidate of installation['files']) {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).sort().join('\0') !== 'mode\0path\0sha256\0size' ||
      !isSafeRelativePath(candidate['path']) ||
      typeof candidate['sha256'] !== 'string' ||
      !/^[0-9a-f]{64}$/.test(candidate['sha256']) ||
      (candidate['mode'] !== '0644' && candidate['mode'] !== '0755') ||
      !Number.isSafeInteger(candidate['size']) ||
      /** @type {number} */ (candidate['size']) < 0
    ) {
      throw new Error('Verifier asset installation metadata is invalid.');
    }
    files.push(/** @type {PackageAssetFile} */ (candidate));
  }
  if (
    files.length === 0 ||
    files.length + 2 + legalNoticeFiles.length > maximumPackageEntries ||
    new Set(files.map((file) => file.path)).size !== files.length ||
    files.some((file, index) => index > 0 && (files[index - 1]?.path.localeCompare(file.path) ?? -1) >= 0)
  ) {
    throw new Error('Verifier asset installation metadata is invalid.');
  }

  const actualFiles = await listFiles(assetRoot);
  const expectedFiles = [...files.map((file) => file.path), 'installation.json'].sort();
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((file, index) => file !== expectedFiles[index])) {
    throw new Error('Verifier asset package contents do not match the installation allowlist.');
  }

  for (const file of files) {
    const absolutePath = path.join(assetRoot, file.path);
    const details = await lstat(absolutePath);
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.size !== file.size ||
      (details.mode & 0o777).toString(8).padStart(4, '0') !== file.mode ||
      sha256(await readFile(absolutePath)) !== file.sha256
    ) {
      throw new Error('Verifier asset package file failed integrity validation.');
    }
  }
  const installationDetails = await lstat(path.join(assetRoot, 'installation.json'));
  if (
    !installationDetails.isFile() ||
    installationDetails.isSymbolicLink() ||
    (installationDetails.mode & 0o777) !== 0o644
  ) {
    throw new Error('Verifier asset installation metadata mode is invalid.');
  }
  const manifest = files.find((file) => file.path === 'asset-manifest.json');
  const trustRoot = files.find((file) => file.path === 'trust/aws-signer-notation-root.cert');
  if (
    !manifest ||
    manifest.sha256 !== installation['assetManifestSha256'] ||
    !trustRoot ||
    trustRoot.sha256 !== installation['trustRootSha256']
  ) {
    throw new Error('Verifier asset package authority does not match its manifest.');
  }
  return {
    verifierVersion: /** @type {string} */ (installation['verifierVersion']),
    assetManifestSha256: /** @type {string} */ (installation['assetManifestSha256']),
    trustRootSha256: /** @type {string} */ (installation['trustRootSha256']),
    files,
  };
}

/**
 * @param {string} outfile
 */
async function defaultBundleHandler(outfile) {
  const { build } = await import('esbuild');
  await build({
    entryPoints: [handlerEntry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    banner: {
      js: 'import { createRequire as __starkCreateRequire } from "node:module"; const require = __starkCreateRequire(import.meta.url);',
    },
    sourcemap: false,
    legalComments: 'inline',
  });
  await chmod(outfile, 0o644);
}

/**
 * @param {string} sourceFile
 * @param {string} zipPath
 * @param {string} assetRoot
 * @param {PackageAssetFile[]} assetFiles
 */
async function writeDeterministicZip(sourceFile, zipPath, assetRoot, assetFiles) {
  await new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addFile(sourceFile, 'index.mjs', {
      compress: true,
      mtime: new Date(0),
      mode: 0o100644,
    });
    for (const notice of legalNoticeFiles) {
      zip.addFile(notice.source, notice.destination, {
        compress: true,
        mtime: new Date(0),
        mode: 0o100644,
      });
    }
    const packageFiles = [...assetFiles, { path: 'installation.json', mode: /** @type {'0644'} */ ('0644') }].sort(
      (left, right) => left.path.localeCompare(right.path),
    );
    for (const file of packageFiles) {
      zip.addFile(path.join(assetRoot, file.path), `image-signature-verifier/${file.path}`, {
        compress: true,
        mtime: new Date(0),
        mode: 0o100000 | Number.parseInt(file.mode, 8),
      });
    }
    zip.outputStream.on('error', reject);
    zip.outputStream
      .pipe(createWriteStream(zipPath, { mode: 0o444 }))
      .on('close', () => resolve(undefined))
      .on('error', reject);
    zip.end();
  });
  await chmod(zipPath, 0o444);
}

/**
 * @typedef {{
 *   platform: 'linux-amd64';
 *   outputDirectory: string;
 *   installAssets?: typeof installImageSignatureVerifierAssets;
 *   bundleHandler?: (outfile: string) => Promise<void>;
 * }} BuilderOptions
 */

/**
 * @param {BuilderOptions} options
 */
export async function buildImageSignatureVerifierLambda(options) {
  if (options.platform !== 'linux-amd64') {
    throw new Error('Image signature verifier Lambda platform is unsupported.');
  }
  const outputDirectory = path.resolve(options.outputDirectory);
  if (outputDirectory === path.parse(outputDirectory).root || outputDirectory === process.cwd()) {
    throw new Error('Image signature verifier Lambda output directory is unsafe.');
  }
  try {
    await lstat(outputDirectory);
    throw new Error('Image signature verifier Lambda output directory already exists.');
  } catch (error) {
    if (!isRecord(error) || error['code'] !== 'ENOENT') {
      throw error;
    }
  }

  await mkdir(path.dirname(outputDirectory), { recursive: true, mode: 0o700 });
  const workRoot = await mkdtemp(path.join(path.dirname(outputDirectory), '.image-signature-verifier-lambda-'));
  await chmod(workRoot, 0o700);
  try {
    const assetRoot = path.join(workRoot, 'assets');
    const bundleRoot = path.join(workRoot, 'bundle');
    const publishRoot = path.join(workRoot, 'publish');
    await mkdir(bundleRoot, { mode: 0o700 });
    await mkdir(publishRoot, { mode: 0o700 });

    const installAssets = options.installAssets ?? installImageSignatureVerifierAssets;
    await installAssets({ architecture: 'amd64', outputDirectory: assetRoot });
    const assets = await validatePackageAssets(assetRoot);
    const bundledHandler = path.join(bundleRoot, 'index.mjs');
    await (options.bundleHandler ?? defaultBundleHandler)(bundledHandler);
    const handlerDetails = await lstat(bundledHandler);
    if (!handlerDetails.isFile() || handlerDetails.isSymbolicLink() || handlerDetails.size <= 0) {
      throw new Error('Bundled image signature verifier handler is invalid.');
    }

    const installationDetails = await stat(path.join(assetRoot, 'installation.json'));
    const legalNoticeDetails = await Promise.all(
      legalNoticeFiles.map(async ({ source }) => {
        const details = await lstat(source);
        if (!details.isFile() || details.isSymbolicLink() || details.size <= 0) {
          throw new Error('Image signature verifier legal notice is invalid.');
        }
        return details;
      }),
    );
    const uncompressedBytes =
      handlerDetails.size +
      installationDetails.size +
      legalNoticeDetails.reduce((total, details) => total + details.size, 0) +
      assets.files.reduce((total, file) => total + file.size, 0);
    if (uncompressedBytes > maximumUncompressedBytes) {
      throw new Error('Image signature verifier Lambda package is too large.');
    }

    const zipPath = path.join(publishRoot, 'image-signature-verifier.zip');
    await writeDeterministicZip(bundledHandler, zipPath, assetRoot, assets.files);
    const zipContents = await readFile(zipPath);
    if (zipContents.length > maximumCompressedBytes) {
      throw new Error('Image signature verifier Lambda ZIP is too large.');
    }
    const zipSha256 = sha256(zipContents);
    const manifest = {
      kind: 'image-signature-verifier-lambda-artifact',
      platform: 'linux-amd64',
      fileName: 'image-signature-verifier.zip',
      sha256: zipSha256,
      sourceCodeHash: Buffer.from(zipSha256, 'hex').toString('base64'),
      assetManifestSha256: assets.assetManifestSha256,
      trustRootSha256: assets.trustRootSha256,
      compressedBytes: zipContents.length,
      uncompressedBytes,
    };
    await writeFile(path.join(publishRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 });
    await chmod(path.join(publishRoot, 'manifest.json'), 0o444);
    await rename(publishRoot, outputDirectory);
    return manifest;
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const args = parseBuilderArguments(process.argv.slice(2));
    const manifest = await buildImageSignatureVerifierLambda(args);
    process.stdout.write(
      `${JSON.stringify({
        kind: manifest.kind,
        platform: manifest.platform,
        sha256: manifest.sha256,
        assetManifestSha256: manifest.assetManifestSha256,
        trustRootSha256: manifest.trustRootSha256,
      })}\n`,
    );
  } catch {
    process.stderr.write('Image signature verifier Lambda build failed.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
