/**
 * Factory for creating zkVM executors
 * Supports both real and mock implementations for new structures
 * Following final-design.md v1.0 specifications
 */

import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import { executeMockZkVM } from './mock-executor';
import { executeZkVM } from './executor';
import type { ZkVMExecutionResult } from '@stark-ballot/zkvm-contract/zkvm/host-io';
import { logger } from './logger';

export type ZkVMProofProfile =
  | { readonly executor: 'mock'; readonly evidence: 'mock' }
  | { readonly executor: 'risc0'; readonly evidence: 'development' | 'production' };

export type Risc0ProofProfile = Extract<ZkVMProofProfile, { readonly executor: 'risc0' }>;

export interface ZkVMExecutor {
  execute: (input: ZkVMInput) => Promise<ZkVMExecutionResult>;
  type: 'real' | 'mock';
  version: string;
}

/**
 * Create a zkVM executor from the resolved runtime proof profile.
 */
export function createZkVMExecutor(proofProfile: ZkVMProofProfile): Promise<ZkVMExecutor> {
  if (proofProfile.executor === 'mock') {
    logger.info('[zkVM] Using mock executor for fast testing');
    return Promise.resolve({
      execute: executeMockZkVM,
      type: 'mock',
      version: '1.0',
    });
  }

  logger.info('[zkVM] Using real zkVM executor with STARK proof generation');
  if (proofProfile.evidence === 'development') {
    logger.warn('[zkVM] WARNING: development evidence selected - No real STARK proofs will be generated!');
  }

  return Promise.resolve({
    execute: (input) => executeZkVM(input, proofProfile),
    type: 'real',
    version: '1.0',
  });
}

/**
 * Create the default executor for the already-resolved proof profile.
 */
export function getDefaultExecutor(proofProfile: ZkVMProofProfile): Promise<ZkVMExecutor> {
  logger.info('[zkVM] Creating executor from resolved runtime profile');
  return createZkVMExecutor(proofProfile);
}
