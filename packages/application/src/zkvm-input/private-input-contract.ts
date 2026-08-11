import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  buildZkVMInputFromSession,
  type ZkVMInputSessionRecords,
  validateCanonicalZkVMInput,
} from '@stark-ballot/application/zkvm-input/input-builder';

export class CanonicalZkVMInputValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Invalid zkVM input structure: ${errors.join('; ')}`);
    this.name = 'CanonicalZkVMInputValidationError';
    this.errors = [...errors];
  }
}

export function buildCanonicalZkVMInputFromSession(records: ZkVMInputSessionRecords): ZkVMInput {
  const zkVMInput = buildZkVMInputFromSession(records);
  const validation = validateCanonicalZkVMInput(zkVMInput);
  if (!validation.valid) {
    throw new CanonicalZkVMInputValidationError(validation.errors);
  }

  return zkVMInput;
}
