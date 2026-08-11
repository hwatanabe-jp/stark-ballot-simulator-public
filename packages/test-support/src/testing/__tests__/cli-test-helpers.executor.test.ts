import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';

const { createZkVMExecutor, execute } = vi.hoisted(() => ({
  createZkVMExecutor: vi.fn(),
  execute: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@stark-ballot/node-adapters/zkvm/executor-factory', () => ({
  createZkVMExecutor,
}));

import { CLITestHelpers } from '../cli-test-helpers';

const input: ZkVMInput = {
  votes: [],
  bulletinRoot: '0x' + '00'.repeat(32),
  treeSize: 1,
  totalExpected: 1,
  electionId: '550e8400-e29b-41d4-a716-446655440000',
  electionConfigHash: '0x' + '00'.repeat(32),
  logId: '0x' + '00'.repeat(32),
  timestamp: 1,
};

describe('CLITestHelpers.executeZkVM', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createZkVMExecutor.mockResolvedValue({
      execute,
      type: 'real',
      version: '1.0',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes the injected proof profile to the executor factory', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const helpers = new CLITestHelpers();
    const proofProfile = {
      executor: 'risc0',
      evidence: 'production',
    } as const;

    await helpers.executeZkVM(input, proofProfile);

    expect(createZkVMExecutor).toHaveBeenCalledWith(proofProfile);
    expect(execute).toHaveBeenCalledWith(input);
    expect(consoleLogSpy.mock.calls).toEqual([['[CLITest] Using real zkVM executor']]);
  });
});
