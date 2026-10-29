import path from 'node:path';
import { rmSync } from 'node:fs';
import { configureLogger } from '@stark-ballot/diagnostics/logger';
import { createFileMockStoreDirectory } from '../workspace/test-support/file-mock-store';

configureLogger({ level: 'warn' });

function configureDefaultTestImageIdVariant(): void {
  if (!process.env['EXPECTED_IMAGE_ID'] && !process.env['EXPECTED_IMAGE_ID_VARIANT']) {
    process.env['EXPECTED_IMAGE_ID_VARIANT'] = 'x86_64';
  }
}

function configureFileMockStoreDirectory(): void {
  const workerId = process.env['VITEST_WORKER_ID'];
  if (!workerId) {
    return;
  }

  const projectName = process.env['STARK_BALLOT_VITEST_PROJECT'];
  if (!projectName) {
    throw new Error('STARK_BALLOT_VITEST_PROJECT is required for file-backed tests');
  }
  const originalDirectory = process.env['FILE_MOCK_STORE_DIR'];
  const directory = createFileMockStoreDirectory(
    originalDirectory || path.join(process.cwd(), '.tmp', 'vitest'),
    projectName,
    workerId,
  );
  process.env['FILE_MOCK_STORE_DIR'] = directory;
  afterAll(() => {
    try {
      rmSync(directory, { recursive: true, force: true });
    } finally {
      if (originalDirectory === undefined) delete process.env['FILE_MOCK_STORE_DIR'];
      else process.env['FILE_MOCK_STORE_DIR'] = originalDirectory;
    }
  });
}

configureDefaultTestImageIdVariant();
if (!process.env['SESSION_CAPABILITY_SECRET']) {
  process.env['SESSION_CAPABILITY_SECRET'] = 'test-session-capability-secret-0123456789abcdef';
}
configureFileMockStoreDirectory();

beforeEach(() => {
  configureDefaultTestImageIdVariant();
});
