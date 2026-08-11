import path from 'node:path';
import { configureLogger } from '@stark-ballot/diagnostics/logger';

configureLogger({ level: 'warn' });

function configureDefaultTestImageIdVariant(): void {
  if (!process.env['EXPECTED_IMAGE_ID'] && !process.env['EXPECTED_IMAGE_ID_VARIANT']) {
    process.env['EXPECTED_IMAGE_ID_VARIANT'] = 'x86_64';
  }
}

function safeDirectorySegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, '_');
}

function configureFileMockStoreDirectory(): void {
  const workerId = process.env['VITEST_WORKER_ID'];
  if (process.env['FILE_MOCK_STORE_DIR'] || !workerId) {
    return;
  }

  const projectName = process.env['STARK_BALLOT_VITEST_PROJECT'];
  if (!projectName) {
    throw new Error('STARK_BALLOT_VITEST_PROJECT is required for file-backed tests');
  }
  process.env['FILE_MOCK_STORE_DIR'] = path.join(
    process.cwd(),
    '.tmp',
    'vitest',
    safeDirectorySegment(projectName),
    `worker-${safeDirectorySegment(workerId)}`,
    'mock-sessions',
  );
}

configureDefaultTestImageIdVariant();
if (!process.env['SESSION_CAPABILITY_SECRET']) {
  process.env['SESSION_CAPABILITY_SECRET'] = 'test-session-capability-secret-0123456789abcdef';
}
configureFileMockStoreDirectory();

beforeEach(() => {
  configureDefaultTestImageIdVariant();
});
