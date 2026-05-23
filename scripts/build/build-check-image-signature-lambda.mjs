import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lambdaSourceDir = path.join(repoRoot, 'terraform/lambda/check-image-signature');
const outDir = path.join(repoRoot, 'terraform/.tmp/check-image-signature');

await rm(outDir, { recursive: true, force: true });
await rm(path.join(lambdaSourceDir, 'node_modules'), { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [path.join(lambdaSourceDir, 'index.mjs')],
  outfile: path.join(outDir, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: false,
  legalComments: 'none',
});

console.log(`Built ${path.relative(repoRoot, outDir)}/index.js`);
