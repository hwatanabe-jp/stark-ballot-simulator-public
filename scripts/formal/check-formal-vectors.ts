#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatSource } from '../formatting/format-source';
import { parseFormalReport } from './formal-report-admission';

const repoRoot = process.cwd();
const tempDir = mkdtempSync(path.join(tmpdir(), 'stark-ballot-formal-vectors-'));

function readFormalReport(relativePath: string) {
  const input: unknown = JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'));
  return parseFormalReport(input);
}

async function formattedJson(filePath: string): Promise<string> {
  return await formatSource(filePath, readFileSync(filePath, 'utf8'));
}

async function main(): Promise<void> {
  try {
    execFileSync('lake', ['exe', 'emitTestVectors', '--out-dir', tempDir], {
      cwd: path.join(repoRoot, 'formal'),
      stdio: 'inherit',
    });

    const report = readFormalReport('docs/formal/formal-report.json');
    const staleArtifacts: string[] = [];

    for (const artifact of report.generatedVectorArtifacts) {
      const committedPath = path.join(repoRoot, artifact.path);
      const generatedPath = path.join(tempDir, path.basename(artifact.path));
      const committedJson = readFileSync(committedPath, 'utf8');
      const expectedJson = await formattedJson(generatedPath);

      if (committedJson !== expectedJson) {
        staleArtifacts.push(artifact.path);
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
