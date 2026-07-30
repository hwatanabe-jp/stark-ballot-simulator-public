export interface VerificationObservation {
  executionId: string;
  fingerprint: string;
  observedAt: number;
}

export type RecordVerificationObservationResult =
  | { status: 'recorded' }
  | { status: 'idempotent' }
  | {
      status: 'conflict';
      reason: 'execution_mismatch' | 'fingerprint_mismatch';
    };

const EXECUTION_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function parseVerificationObservation(value: unknown): VerificationObservation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'executionId' && key !== 'fingerprint' && key !== 'observedAt')) {
    return undefined;
  }
  const executionId = record['executionId'];
  const fingerprint = record['fingerprint'];
  const observedAt = record['observedAt'];
  if (
    typeof executionId !== 'string' ||
    executionId.length === 0 ||
    executionId.length > 256 ||
    !EXECUTION_ID_PATTERN.test(executionId) ||
    typeof fingerprint !== 'string' ||
    !SHA256_HEX_PATTERN.test(fingerprint) ||
    typeof observedAt !== 'number' ||
    !Number.isSafeInteger(observedAt) ||
    observedAt < 0
  ) {
    return undefined;
  }
  return { executionId, fingerprint, observedAt };
}

export function requireVerificationObservation(value: unknown): VerificationObservation {
  const observation = parseVerificationObservation(value);
  if (!observation) {
    throw new Error('Invalid verification observation');
  }
  return observation;
}

export function resolveVerificationObservationRecord(
  currentExecutionId: string | undefined,
  existing: VerificationObservation | undefined,
  requested: VerificationObservation,
): RecordVerificationObservationResult {
  if (currentExecutionId !== requested.executionId) {
    return { status: 'conflict', reason: 'execution_mismatch' };
  }
  if (!existing || existing.executionId !== requested.executionId) {
    return { status: 'recorded' };
  }
  return existing.fingerprint === requested.fingerprint
    ? { status: 'idempotent' }
    : { status: 'conflict', reason: 'fingerprint_mismatch' };
}
