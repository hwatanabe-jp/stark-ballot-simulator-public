import type { SessionData } from '@/types/server';
import type { ZkVMInput } from '@/lib/zkvm/types';
import { buildZkVMInputFromSession, validateZkVMInput } from '@/lib/zkvm/input-builder';

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
  const validation = validateZkVMInput(zkVMInput);
  if (!validation.valid) {
    throw new CanonicalZkVMInputValidationError(validation.errors);
  }

  return zkVMInput;
}
