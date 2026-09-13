export interface VerificationObservation {
  finalizationId: string;
  fingerprint: string;
  observedAt: number;
}

export type VerificationObservationWrite = Omit<VerificationObservation, 'finalizationId'>;

export type RecordVerificationObservationResult =
  | { status: 'recorded' }
  | { status: 'idempotent' }
  | {
      status: 'conflict';
      reason: 'finalization_mismatch' | 'fingerprint_mismatch';
    };

const FINALIZATION_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function parseVerificationObservationWrite(value: unknown): VerificationObservationWrite | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || keys.some((key) => key !== 'fingerprint' && key !== 'observedAt')) {
    return undefined;
  }
  const fingerprint = record['fingerprint'];
  const observedAt = record['observedAt'];
  if (
    typeof fingerprint !== 'string' ||
    !SHA256_HEX_PATTERN.test(fingerprint) ||
    typeof observedAt !== 'number' ||
    !Number.isSafeInteger(observedAt) ||
    observedAt < 0
  ) {
    return undefined;
  }
  return { fingerprint, observedAt };
}

export function parseVerificationObservation(value: unknown): VerificationObservation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'finalizationId' && key !== 'fingerprint' && key !== 'observedAt')) {
    return undefined;
  }
  const finalizationId = record['finalizationId'];
  const fingerprint = record['fingerprint'];
  const observedAt = record['observedAt'];
  if (
    typeof finalizationId !== 'string' ||
    finalizationId.length === 0 ||
    finalizationId.length > 256 ||
    !FINALIZATION_ID_PATTERN.test(finalizationId) ||
    typeof fingerprint !== 'string' ||
    !SHA256_HEX_PATTERN.test(fingerprint) ||
    typeof observedAt !== 'number' ||
    !Number.isSafeInteger(observedAt) ||
    observedAt < 0
  ) {
    return undefined;
  }
  return { finalizationId, fingerprint, observedAt };
}

export function resolveVerificationObservationRecord(
  currentFinalizationId: string | undefined,
  existing: VerificationObservation | undefined,
  requested: VerificationObservation,
): RecordVerificationObservationResult {
  if (currentFinalizationId !== requested.finalizationId) {
    return { status: 'conflict', reason: 'finalization_mismatch' };
  }
  if (!existing || existing.finalizationId !== requested.finalizationId) {
    return { status: 'recorded' };
  }
  return existing.fingerprint === requested.fingerprint
    ? { status: 'idempotent' }
    : { status: 'conflict', reason: 'fingerprint_mismatch' };
}
