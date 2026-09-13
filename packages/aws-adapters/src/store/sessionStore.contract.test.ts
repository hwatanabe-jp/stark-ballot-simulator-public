import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, vi, type MockInstance } from 'vitest';
import { logger } from '@stark-ballot/diagnostics/logger';
import { FileMockSessionStore } from './fileMockSessionStore';
import { MockSessionStore } from './mockSessionStore';
import { defineSessionStoreContract } from './test-support/sessionStoreContract';

let warnLog: MockInstance<typeof logger.warn>;

beforeEach(() => {
  warnLog = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  try {
    const testName = expect.getState().currentTestName;
    if (testName?.endsWith('keeps terminal cancellation sticky against late callbacks and success side effects')) {
      expect(warnLog).toHaveBeenCalledTimes(2);
      expect(warnLog).toHaveBeenNthCalledWith(
        1,
        'finalize_state_update_rejected',
        expect.objectContaining({
          event: 'finalize_state_update_rejected',
          finalization_id: 'contract-cancelled',
          reason: 'USER_CANCELLED',
          to: 'running',
        }),
      );
      expect(warnLog).toHaveBeenNthCalledWith(
        2,
        'finalize_state_update_rejected',
        expect.objectContaining({
          event: 'finalize_state_update_rejected',
          finalization_id: 'contract-cancelled',
          reason: 'USER_CANCELLED',
          to: 'succeeded',
        }),
      );
    } else if (
      testName?.endsWith(
        'returns current authority for stale identities and characterizes same-id nonterminal replacement',
      )
    ) {
      expect(warnLog).toHaveBeenCalledOnce();
      expect(warnLog).toHaveBeenCalledWith(
        'finalize_state_update_rejected',
        expect.objectContaining({
          event: 'finalize_state_update_rejected',
          finalization_id: 'contract-stale',
          reason: 'EXECUTION_MISMATCH',
          to: 'pending',
        }),
      );
    } else {
      expect(warnLog).not.toHaveBeenCalled();
    }
  } finally {
    vi.restoreAllMocks();
  }
});

function createFileStoreAt(storageDir: string): FileMockSessionStore {
  const previousStorageDir = process.env['FILE_MOCK_STORE_DIR'];
  process.env['FILE_MOCK_STORE_DIR'] = storageDir;
  try {
    return new FileMockSessionStore();
  } finally {
    if (previousStorageDir === undefined) {
      delete process.env['FILE_MOCK_STORE_DIR'];
    } else {
      process.env['FILE_MOCK_STORE_DIR'] = previousStorageDir;
    }
  }
}

defineSessionStoreContract({
  name: 'MockSessionStore',
  createHarness: () =>
    Promise.resolve({
      store: new MockSessionStore(),
    }),
});

defineSessionStoreContract({
  name: 'FileMockSessionStore',
  capabilities: {
    durableReload: true,
    lifecycleWriteFailure: true,
  },
  async createHarness() {
    const storageDir = await mkdtemp(path.join(tmpdir(), 'stark-ballot-file-store-contract-'));
    return {
      store: createFileStoreAt(storageDir),
      reload: () => Promise.resolve(createFileStoreAt(storageDir)),
      async failNextLifecycleWrite() {
        await mkdir(path.join(storageDir, 'sessions.json.tmp'));
      },
      cleanup: () => rm(storageDir, { recursive: true, force: true }),
    };
  },
});
