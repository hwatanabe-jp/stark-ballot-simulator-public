#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { format, resolveConfig, type Options } from 'prettier';

interface FormalReport {
  generatedVectorArtifacts: string[];
}

const repoRoot = process.cwd();
const tempDir = mkdtempSync(path.join(tmpdir(), 'stark-ballot-formal-vectors-'));
let prettierOptions: Options | null = null;

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8')) as T;
}

async function formattedJson(filePath: string): Promise<string> {
  prettierOptions ??= (await resolveConfig(path.join(repoRoot, 'package.json'))) ?? {};
  return await format(readFileSync(filePath, 'utf8'), { ...prettierOptions, filepath: filePath, parser: 'json' });
}

async function main(): Promise<void> {
  try {
    execFileSync('lake', ['exe', 'emitTestVectors', '--out-dir', tempDir], {
      cwd: path.join(repoRoot, 'formal'),
      stdio: 'inherit',
    });

    const report = readJson<FormalReport>('docs/current/formal/formal-report.json');
    const staleArtifacts: string[] = [];

    for (const artifact of report.generatedVectorArtifacts) {
      const committedPath = path.join(repoRoot, artifact);
      const generatedPath = path.join(tempDir, path.basename(artifact));
      const committedJson = readFileSync(committedPath, 'utf8');
      const expectedJson = await formattedJson(generatedPath);

      if (committedJson !== expectedJson) {
        staleArtifacts.push(artifact);
      }
    }

    if (staleArtifacts.length > 0) {
      throw new Error(`formal vector artifact is stale; run pnpm formal:vectors:\n${staleArtifacts.join('\n')}`);
    }

    console.log('formal vectors are fresh');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
