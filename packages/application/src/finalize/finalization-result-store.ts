import type { VerificationReport, VerificationResult } from '@stark-ballot/verification/shared/types';
import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import { parseVerificationResult } from './finalization-storage';
import type { FinalizationId } from './finalization-types';

export interface VerificationResultRecord {
  sessionId: string;
  finalizationId: FinalizationId;
  verificationResult: VerificationResult;
}

const VERIFICATION_RESULT_RECORD_KEYS = new Set(['sessionId', 'finalizationId', 'verificationResult']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  const sessionId = value['sessionId'];
  const finalizationId = value['finalizationId'];
  const verificationResult = parseVerificationResult(value['verificationResult']);
  if (
    typeof sessionId !== 'string' ||
    !isSafeVerifierSegment(sessionId) ||
    typeof finalizationId !== 'string' ||
    !isSafeVerifierSegment(finalizationId) ||
    !verificationResult
  ) {
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
    sessionId: string,
    finalizationId: FinalizationId,
  ): Promise<VerificationResultRecord | null>;

  markVerificationRunning(
    sessionId: string,
    finalizationId: FinalizationId,
    report?: VerificationReport,
  ): Promise<VerificationResultRecord>;

  rollbackVerificationResult(sessionId: string, finalizationId: FinalizationId): Promise<void>;

  completeVerificationResult(
    sessionId: string,
    finalizationId: FinalizationId,
    verificationResult: VerificationResult,
  ): Promise<VerificationResultRecord>;
}
