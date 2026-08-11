import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';

const { executeMockZkVM, executeRisc0ZkVM } = vi.hoisted(() => ({
  executeMockZkVM: vi.fn().mockResolvedValue(undefined),
  executeRisc0ZkVM: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./mock-executor', () => ({
  executeMockZkVM,
}));

vi.mock('./executor', () => ({
  executeZkVM: executeRisc0ZkVM,
}));

import { createZkVMExecutor, getDefaultExecutor } from './executor-factory';

const MOCK_PROOF_PROFILE = {
  executor: 'mock',
  evidence: 'mock',
} as const;

const DEVELOPMENT_PROOF_PROFILE = {
  executor: 'risc0',
  evidence: 'development',
} as const;

const PRODUCTION_PROOF_PROFILE = {
  executor: 'risc0',
  evidence: 'production',
} as const;

const DEVELOPMENT_EVIDENCE_WARNING =
  '[zkVM] WARNING: development evidence selected - No real STARK proofs will be generated!';

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

describe('zkVM proof profile selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('selects the mock executor from the injected proof profile', async () => {
    const executor = await createZkVMExecutor(MOCK_PROOF_PROFILE);
    await executor.execute(input);

    expect(executor.type).toBe('mock');
    expect(executeMockZkVM).toHaveBeenCalledWith(input);
    expect(executeRisc0ZkVM).not.toHaveBeenCalled();
  });

  it.each([DEVELOPMENT_PROOF_PROFILE, PRODUCTION_PROOF_PROFILE])(
    'selects the RISC Zero executor and preserves $evidence evidence',
    async (proofProfile) => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const executor = await createZkVMExecutor(proofProfile);
      await executor.execute(input);

      expect(executor.type).toBe('real');
      expect(executeRisc0ZkVM).toHaveBeenCalledWith(input, proofProfile);
      expect(executeMockZkVM).not.toHaveBeenCalled();
      if (proofProfile.evidence === 'development') {
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(warnSpy).toHaveBeenCalledWith(DEVELOPMENT_EVIDENCE_WARNING);
      } else {
        expect(warnSpy).not.toHaveBeenCalled();
      }
    },
  );

  it('honors the proof profile on every default-executor request without an environment cache', async () => {
    const mockExecutor = await getDefaultExecutor(MOCK_PROOF_PROFILE);
    const realExecutor = await getDefaultExecutor(PRODUCTION_PROOF_PROFILE);

    expect(mockExecutor.type).toBe('mock');
    expect(realExecutor.type).toBe('real');
    expect(mockExecutor).not.toBe(realExecutor);
  });
});
