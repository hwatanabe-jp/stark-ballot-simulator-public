import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as yazl from 'yazl';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outRoot = path.join(repoRoot, '.tmp/target-lambdas');
const tsconfigPath = path.join(repoRoot, 'tooling/tsconfig/paths.json');

/** @type {Array<[string, string]>} */
const targets = [
  ['public_api', 'infra/lambdas/public-api/handler.ts'],
  ['finalization_writer', 'infra/lambdas/finalization-writer/handler.ts'],
  ['proof_dispatcher', 'infra/lambdas/proof-dispatcher/handler.ts'],
  ['verification_worker', 'infra/lambdas/verification-worker/handler.ts'],
  ['semaphore_janitor', 'infra/lambdas/semaphore-janitor/handler.ts'],
];

/**
 * @typedef {{ pattern: string; prefix: string; suffix: string; replacement: string; wildcard: boolean }} AliasEntry
 * @typedef {{ verifierServiceBinaryPath?: string }} ZipOptions
 */

/** @param {unknown} replacements @returns {string | undefined} */
function readAliasReplacement(replacements) {
  if (!Array.isArray(replacements) || replacements.length === 0) return undefined;
  return typeof replacements[0] === 'string' ? replacements[0] : undefined;
}

/** @param {AliasEntry} entry @param {string} importPath @returns {string | undefined} */
function wildcardAliasReplacement(entry, importPath) {
  if (!importPath.startsWith(entry.prefix) || !importPath.endsWith(entry.suffix)) return undefined;
  const wildcardValue = importPath.slice(entry.prefix.length, importPath.length - entry.suffix.length);
  return entry.replacement.replace('*', wildcardValue);
}

/** @param {AliasEntry} entry @param {string} importPath @returns {string | undefined} */
function matchAliasReplacement(entry, importPath) {
  if (entry.wildcard) return wildcardAliasReplacement(entry, importPath);
  return importPath === entry.pattern ? entry.replacement : undefined;
}

/** @param {string} candidate @returns {Promise<boolean>} */
async function isSourceFile(candidate) {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    // Try the next extension.
    return false;
  }
}

const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf8'));
/** @type {AliasEntry[]} */
const aliasEntries = Object.entries(tsconfig.compilerOptions?.paths ?? {})
  .flatMap(([pattern, replacements]) => {
    const replacement = readAliasReplacement(replacements);
    if (replacement === undefined) return [];
    const wildcardIndex = pattern.indexOf('*');
    if (wildcardIndex === -1) {
      return [
        {
          pattern,
          prefix: pattern,
          suffix: '',
          replacement,
          wildcard: false,
        },
      ];
    }
    return [
      {
        pattern,
        prefix: pattern.slice(0, wildcardIndex),
        suffix: pattern.slice(wildcardIndex + 1),
        replacement,
        wildcard: true,
      },
    ];
  })
  .sort((left, right) => right.prefix.length - left.prefix.length);

/**
 * @param {string} importPath
 * @returns {string | undefined}
 */
function resolveAliasPath(importPath) {
  for (const entry of aliasEntries) {
    const replacement = matchAliasReplacement(entry, importPath);
    if (replacement !== undefined) return path.resolve(path.dirname(tsconfigPath), replacement);
  }
  return undefined;
}

/**
 * @param {string} importPath
 * @returns {Promise<string | undefined>}
 */
async function resolveSourcePath(importPath) {
  const basePath = resolveAliasPath(importPath);
  if (!basePath) {
    return undefined;
  }
  for (const candidate of [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    path.join(basePath, 'index.ts'),
    path.join(basePath, 'index.tsx'),
    path.join(basePath, 'index.js'),
  ]) {
    if (await isSourceFile(candidate)) return candidate;
  }
  return basePath;
}

const aliasPlugin = {
  name: 'stark-ballot-path-alias',
  /**
   * @param {import('esbuild').PluginBuild} buildApi
   */
  setup(buildApi) {
    buildApi.onResolve({ filter: /^(?:@\/|@stark-ballot\/)/ }, async (args) => {
      const resolved = await resolveSourcePath(args.path);
      return resolved ? { path: resolved } : undefined;
    });
  },
};

/**
 * @param {string} sourceDir
 * @param {string} zipPath
 * @param {ZipOptions} [options]
 */
async function writeZip(sourceDir, zipPath, options = {}) {
  const { createWriteStream } = await import('node:fs');
  await new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addFile(path.join(sourceDir, 'index.mjs'), 'index.mjs', {
      compress: true,
      mtime: new Date(0),
      mode: 0o100644,
    });
    if (options.verifierServiceBinaryPath) {
      zip.addFile(options.verifierServiceBinaryPath, 'verifier-service', {
        compress: true,
        mtime: new Date(0),
        mode: 0o100755,
      });
    }
    zip.outputStream.on('error', reject);
    zip.outputStream
      .pipe(createWriteStream(zipPath))
      .on('close', () => resolve(undefined))
      .on('error', reject);
    zip.end();
  });
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function sha256(filePath) {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return hash.digest('hex');
}

await rm(outRoot, { recursive: true, force: true });
await mkdir(outRoot, { recursive: true });

/** @type {Record<string, { entry: string; fileName: string; path: string; sha256: string; sourceCodeHash: string; assetManifestSha256?: string; trustRootSha256?: string }>} */
const artifacts = {};

for (const [name, entry] of targets) {
  const targetDir = path.join(outRoot, name);
  const outfile = path.join(targetDir, 'index.mjs');
  const zipPath = path.join(outRoot, `${name}.zip`);
  await mkdir(targetDir, { recursive: true });

  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    banner: {
      js: 'import { createRequire as __starkCreateRequire } from "node:module"; const require = __starkCreateRequire(import.meta.url);',
    },
    sourcemap: false,
    legalComments: 'none',
    plugins: [aliasPlugin],
  });

  const verifierServiceBinaryPath =
    name === 'verification_worker'
      ? path.join(repoRoot, 'verifier-service/target/release/verifier-service')
      : undefined;
  if (verifierServiceBinaryPath) {
    await stat(verifierServiceBinaryPath);
  }

  await writeZip(targetDir, zipPath, verifierServiceBinaryPath ? { verifierServiceBinaryPath } : {});
  const digest = await sha256(zipPath);
  artifacts[name] = {
    entry,
    fileName: `${name}.zip`,
    path: path.relative(repoRoot, zipPath),
    sha256: digest,
    sourceCodeHash: Buffer.from(digest, 'hex').toString('base64'),
  };
}

// Prepare retains the exact ZIP that passed native signature verification.
// Its bytes are checked here and again against admitted preflight authority by
// the publisher; a missing package fails instead of rebuilding different bytes.
const preflightPackage = JSON.parse(
  await readFile(path.join(repoRoot, 'image-signature-preflight-validation.json'), 'utf8'),
).verifier.package;
const imageSignatureVerifierZipPath = path.join(outRoot, 'image_signature_verifier.zip');
await copyFile(
  path.join(repoRoot, '.tmp/app-signature-preflight/image-signature-verifier.zip'),
  imageSignatureVerifierZipPath,
);
const imageSignatureVerifierDigest = await sha256(imageSignatureVerifierZipPath);
if (
  imageSignatureVerifierDigest !== preflightPackage.sha256 ||
  Buffer.from(imageSignatureVerifierDigest, 'hex').toString('base64') !== preflightPackage.source_code_hash
) {
  throw new Error('Retained signature verifier package differs from its preflighted bytes.');
}
const imageSignatureVerifierManifest = {
  sha256: imageSignatureVerifierDigest,
  sourceCodeHash: preflightPackage.source_code_hash,
  assetManifestSha256: preflightPackage.asset_manifest_sha256,
  trustRootSha256: preflightPackage.trust_root_sha256,
};
artifacts['image_signature_verifier'] = {
  entry: 'infra/lambdas/image-signature-verifier/index.mjs',
  fileName: 'image_signature_verifier.zip',
  path: path.relative(repoRoot, imageSignatureVerifierZipPath),
  sha256: imageSignatureVerifierManifest.sha256,
  sourceCodeHash: imageSignatureVerifierManifest.sourceCodeHash,
  assetManifestSha256: imageSignatureVerifierManifest.assetManifestSha256,
  trustRootSha256: imageSignatureVerifierManifest.trustRootSha256,
};

await writeFile(path.join(outRoot, 'manifest.json'), JSON.stringify({ artifacts }, null, 2) + '\n');
console.log(`Built target Lambda artifacts in ${path.relative(repoRoot, outRoot)}`);
