import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as yazl from 'yazl';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outRoot = path.join(repoRoot, '.tmp/foundation-lambdas');
const sourceEntry = 'infra/lambdas/ecr-retention/index.ts';
const sourcePath = path.join(repoRoot, sourceEntry);
const buildRoot = path.join(outRoot, 'ecr_retention');
const bundlePath = path.join(buildRoot, 'index.mjs');
const zipPath = path.join(outRoot, 'ecr_retention.zip');
const manifestPath = path.join(outRoot, 'manifest.json');
const checksumPath = path.join(outRoot, 'ecr_retention.zip.sha256');
const tsconfigPath = path.join(repoRoot, 'tooling/tsconfig/paths.json');

const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf8'));
const aliasEntries = Object.entries(tsconfig.compilerOptions?.paths ?? {})
  .flatMap(([pattern, replacements]) => {
    if (!Array.isArray(replacements) || typeof replacements[0] !== 'string') return [];
    const replacement = replacements[0];
    const wildcardIndex = pattern.indexOf('*');
    return [
      wildcardIndex === -1
        ? { pattern, prefix: pattern, suffix: '', replacement, wildcard: false }
        : {
            pattern,
            prefix: pattern.slice(0, wildcardIndex),
            suffix: pattern.slice(wildcardIndex + 1),
            replacement,
            wildcard: true,
          },
    ];
  })
  .sort((left, right) => right.prefix.length - left.prefix.length);

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

async function resolveSourcePath(importPath) {
  const basePath = resolveAliasPath(importPath);
  if (!basePath) return undefined;
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
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next supported source form.
    }
  }
  return basePath;
}

const aliasPlugin = {
  name: 'stark-ballot-path-alias',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^(?:@\/|@stark-ballot\/)/ }, async (args) => {
      const resolved = await resolveSourcePath(args.path);
      return resolved ? { path: resolved } : undefined;
    });
  },
};

async function sha256(filePath) {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

async function writeDeterministicZip() {
  await new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addFile(bundlePath, 'index.mjs', {
      compress: false,
      mtime: new Date(0),
      mode: 0o100644,
    });
    zip.outputStream.on('error', reject);
    zip.outputStream
      .pipe(createWriteStream(zipPath, { mode: 0o600 }))
      .on('close', resolve)
      .on('error', reject);
    zip.end();
  });
}

await rm(outRoot, { recursive: true, force: true });
await mkdir(buildRoot, { recursive: true });

await build({
  entryPoints: [sourcePath],
  outfile: bundlePath,
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

await writeDeterministicZip();
const digest = await sha256(zipPath);
const manifest = {
  artifact: {
    entry: sourceEntry,
    fileName: 'ecr_retention.zip',
    sha256: digest,
    sourceCodeHash: Buffer.from(digest, 'hex').toString('base64'),
  },
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
await writeFile(checksumPath, `${digest}  .tmp/foundation-lambdas/ecr_retention.zip\n`, { mode: 0o600 });
console.log(`Built ECR retention Lambda at ${path.relative(repoRoot, zipPath)}`);
