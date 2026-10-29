import { isNonArrayObject as isRecord } from '@stark-ballot/validation/unknown-value-guards';
import type { VerificationResult } from '@stark-ballot/verification/shared/types';
import { asSessionId, type SessionId } from '@stark-ballot/domain/types/identifiers';
import { parseVerificationResult } from './finalization-storage';
import { parseFinalizationId } from './finalization-id';
import type { FinalizationId } from './finalization-types';

export interface VerificationResultRecord {
  sessionId: SessionId;
  finalizationId: FinalizationId;
  verificationResult: VerificationResult;
}

const VERIFICATION_RESULT_RECORD_KEYS = new Set(['sessionId', 'finalizationId', 'verificationResult']);

export function parseVerificationResultRecord(value: unknown): VerificationResultRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (
    keys.length !== VERIFICATION_RESULT_RECORD_KEYS.size ||
    !keys.every((key) => VERIFICATION_RESULT_RECORD_KEYS.has(key))
  ) {
    return undefined;
  }
  const rawSessionId = value['sessionId'];
  const sessionId = typeof rawSessionId === 'string' ? parseSessionId(rawSessionId) : undefined;
  const finalizationId = parseFinalizationId(value['finalizationId']);
  const verificationResult = parseVerificationResult(value['verificationResult']);
  if (!sessionId || !finalizationId || !verificationResult) {
    return undefined;
  }
  return {
    sessionId,
    finalizationId,
    verificationResult,
  };
}

export interface VerificationResultStore {
  getVerificationResultRecord(
    sessionId: SessionId,
    finalizationId: FinalizationId,
  ): Promise<VerificationResultRecord | null>;

  markVerificationRunning(sessionId: SessionId, finalizationId: FinalizationId): Promise<VerificationResultRecord>;

  rollbackVerificationResult(sessionId: SessionId, finalizationId: FinalizationId): Promise<void>;

  completeVerificationResult(
    sessionId: SessionId,
    finalizationId: FinalizationId,
    verificationResult: VerificationResult,
  ): Promise<VerificationResultRecord>;
}

function parseSessionId(value: string): SessionId | undefined {
  try {
    return asSessionId(value);
  } catch {
    return undefined;
  }
}

export function isTerminalVerificationStatus(status: VerificationResult['status']): boolean {
  return status === 'success' || status === 'failed' || status === 'dev_mode';
}

export function createVerificationResultRecord(
  sessionId: SessionId,
  finalizationId: FinalizationId,
  verificationResult: VerificationResult,
): VerificationResultRecord {
  const record = parseVerificationResultRecord({ sessionId, finalizationId, verificationResult });
  if (!record) throw new Error('Invalid verification result record');
  return record;
}
