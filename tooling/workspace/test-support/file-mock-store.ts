import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';

/** Each file/run owns a disposable child directory, including with an explicit base. */
export function createFileMockStoreDirectory(baseDirectory: string, projectName: string, workerId: string): string {
  const base = path.resolve(baseDirectory);
  mkdirSync(base, { recursive: true });
  const prefix = `${projectName}-worker-${workerId}`.replace(/[^A-Za-z0-9._-]/gu, '_');
  return mkdtempSync(path.join(base, `${prefix}-`));
}
