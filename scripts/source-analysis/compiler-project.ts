import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CompilerProject {
  readonly options: Readonly<Record<string, unknown>>;
  readonly fileNames: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function loadCompilerProject(projectPath: string): CompilerProject {
  const absolutePath = path.resolve(projectPath);
  const compiler = path.join(path.dirname(fileURLToPath(import.meta.resolve('typescript/package.json'))), 'bin/tsc');
  // --showConfig can omit configuration diagnostics, including a missing extends target.
  execFileSync(process.execPath, [compiler, '--noEmit', '--listFilesOnly', '--project', absolutePath], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = execFileSync(process.execPath, [compiler, '--showConfig', '--project', absolutePath], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed: unknown = JSON.parse(output);
  if (
    !isRecord(parsed) ||
    !isRecord(parsed['compilerOptions']) ||
    !Array.isArray(parsed['files']) ||
    !parsed['files'].every((file: unknown) => typeof file === 'string')
  ) {
    throw new Error(`Compiler returned an invalid project configuration for ${absolutePath}.`);
  }
  return {
    options: parsed['compilerOptions'],
    fileNames: parsed['files'].map((file: string) => path.resolve(path.dirname(absolutePath), file)),
  };
}
