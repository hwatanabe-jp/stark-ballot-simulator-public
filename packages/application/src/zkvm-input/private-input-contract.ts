import type { SessionData } from '@stark-ballot/domain/types/server';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  buildZkVMInputFromSession,
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

export function buildCanonicalZkVMInputFromSession(session: SessionData): ZkVMInput {
  const zkVMInput = buildZkVMInputFromSession(session);
  const validation = validateCanonicalZkVMInput(zkVMInput);
  if (!validation.valid) {
    throw new CanonicalZkVMInputValidationError(validation.errors);
  }

  return zkVMInput;
}
