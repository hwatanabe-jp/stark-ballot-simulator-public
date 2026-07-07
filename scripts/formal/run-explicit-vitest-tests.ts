#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const args = process.argv.slice(2);
const separatorIndex = args.indexOf('--');
const explicitArgs = separatorIndex >= 0 ? args.slice(0, separatorIndex) : args;
const forwardedArgs = separatorIndex >= 0 ? [...explicitArgs, ...args.slice(separatorIndex + 1)] : args;

function isExplicitTestPath(value: string): boolean {
  return !value.startsWith('-') && value.endsWith('.test.ts');
}

function validateExplicitTestPaths(paths: readonly string[]): void {
  const missingPaths = paths.filter((testPath) => {
    const absolutePath = path.resolve(repoRoot, testPath);
    return !existsSync(absolutePath) || !statSync(absolutePath).isFile();
  });

  if (missingPaths.length > 0) {
    throw new Error(`formal:test:ts references stale test path(s):\n${missingPaths.join('\n')}`);
  }
}

const explicitTestPaths = explicitArgs.filter(isExplicitTestPath);
validateExplicitTestPaths(explicitTestPaths);

const result = spawnSync('pnpm', ['exec', 'vitest', 'run', ...forwardedArgs], {
  cwd: repoRoot,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
