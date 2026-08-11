import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as yazl from 'yazl';
import { buildImageSignatureVerifierLambda } from './build-image-signature-verifier-lambda.mjs';

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

const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf8'));
/** @type {AliasEntry[]} */
const aliasEntries = Object.entries(tsconfig.compilerOptions?.paths ?? {})
  .flatMap(([pattern, replacements]) => {
    if (!Array.isArray(replacements) || replacements.length === 0) {
      return [];
    }
    const replacement = replacements[0];
    if (typeof replacement !== 'string') {
      return [];
    }
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
    if (!entry.wildcard && importPath === entry.pattern) {
      return path.resolve(path.dirname(tsconfigPath), entry.replacement);
    }
    if (entry.wildcard && importPath.startsWith(entry.prefix) && importPath.endsWith(entry.suffix)) {
      const wildcardValue = importPath.slice(entry.prefix.length, importPath.length - entry.suffix.length);
      return path.resolve(path.dirname(tsconfigPath), entry.replacement.replace('*', wildcardValue));
    }
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
    try {
      if ((await stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next extension.
    }
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

const imageSignatureVerifierBuildRoot = path.join(outRoot, '.image-signature-verifier-build');
const imageSignatureVerifierManifest = await buildImageSignatureVerifierLambda({
  platform: 'linux-amd64',
  outputDirectory: imageSignatureVerifierBuildRoot,
});
const imageSignatureVerifierZipPath = path.join(outRoot, 'image_signature_verifier.zip');
await copyFile(
  path.join(imageSignatureVerifierBuildRoot, imageSignatureVerifierManifest.fileName),
  imageSignatureVerifierZipPath,
);
await rm(imageSignatureVerifierBuildRoot, { recursive: true, force: true });
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
