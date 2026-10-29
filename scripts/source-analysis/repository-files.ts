import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function trackedAndUntrackedFiles(repositoryRoot: string, failureMessage: string): string[] {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(failureMessage);
  return result.stdout.split('\0').filter(Boolean);
}

export function scanRepositoryFiles<T>(
  repositoryRoot: string,
  files: readonly string[],
  includesPath: (relativePath: string) => boolean,
  inspectText: (relativePath: string, contents: string) => readonly T[],
  readsContent: (relativePath: string) => boolean = () => true,
): T[] {
  const findings: T[] = [];
  for (const relativePath of files) {
    if (!includesPath(relativePath)) continue;
    const absolutePath = path.join(repositoryRoot, relativePath);
    if (!existsSync(absolutePath)) continue;
    const contents = readsContent(relativePath) ? readFileSync(absolutePath, 'utf8') : '';
    findings.push(...inspectText(relativePath, contents));
  }
  return findings;
}

type SourceFinding = { readonly path: string; readonly line: number; readonly rule: string; readonly token?: string };

export function compareSourceFindings(left: SourceFinding, right: SourceFinding): number {
  return (
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.rule.localeCompare(right.rule) ||
    (left.token ?? '').localeCompare(right.token ?? '')
  );
}
