import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import type { ZkVMExecutionResult } from '@stark-ballot/zkvm-contract/zkvm/host-io';

export type { ZkVMExecutionResult } from '@stark-ballot/zkvm-contract/zkvm/host-io';

export interface ZkVMExecutor {
  execute: (input: ZkVMInput) => Promise<ZkVMExecutionResult>;
  type: 'real' | 'mock';
  version: string;
}
