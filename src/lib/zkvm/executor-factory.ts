/**
 * Factory for creating zkVM executors
 * Supports both real and mock implementations for new structures
 * Following final_design.md v1.0 specifications
 */

import type { ZkVMInput } from './types';
import { executeMockZkVM, shouldUseMockZkVM } from './mock-executor';
import { assertZkvmModeAllowed, resolveZkvmMode } from './zkvm-mode';
import { executeZkVM, type ZkVMExecutionResult } from './executor';
import { logger } from '@/lib/utils/logger';

export interface ZkVMExecutor {
  execute: (input: ZkVMInput) => Promise<ZkVMExecutionResult>;
  type: 'real' | 'mock';
  version: string;
}

export interface ZkVMConfig {
  useMock?: boolean;
  verbose?: boolean;
}

/**
 * Create a zkVM v2 executor based on configuration
 */
export function createZkVMExecutor(config?: ZkVMConfig): Promise<ZkVMExecutor> {
  const useMock = config?.useMock ?? shouldUseMockZkVM();
  const mode = resolveZkvmMode({ useMock });
  assertZkvmModeAllowed(mode);

  if (useMock) {
    logger.info('[zkVM] Using mock executor for fast testing');
    return Promise.resolve({
      execute: executeMockZkVM,
      type: 'mock',
      version: '1.0',
    });
  }

  logger.info('[zkVM] Using real zkVM executor with STARK proof generation');
  if (process.env.RISC0_DEV_MODE === '1') {
    logger.warn('[zkVM] WARNING: RISC0_DEV_MODE=1 - No real STARK proofs will be generated!');
  }

  return Promise.resolve({
    execute: executeZkVM,
    type: 'real',
    version: '1.0',
  });
}

/**
 * Default executor instance (cached)
 * Automatically selects mock or real based on environment
 */
let defaultExecutor: ZkVMExecutor | null = null;
let lastUseMockZkVM: string | undefined = undefined;
let lastRisc0DevMode: string | undefined = undefined;

export async function getDefaultExecutor(): Promise<ZkVMExecutor> {
  // Check if environment changed and recreate executor if needed
  const currentUseMock = process.env.USE_MOCK_ZKVM;
  const currentRiscMode = process.env.RISC0_DEV_MODE;

  if (defaultExecutor && lastUseMockZkVM === currentUseMock && lastRisc0DevMode === currentRiscMode) {
    return defaultExecutor;
  }

  // Environment changed or first time, create new executor
  logger.info('[zkVM] Creating executor with current environment settings');
  defaultExecutor = await createZkVMExecutor();
  lastUseMockZkVM = currentUseMock;
  lastRisc0DevMode = currentRiscMode;

  return defaultExecutor;
}
