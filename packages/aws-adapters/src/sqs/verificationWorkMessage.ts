import { isNonArrayObject as isRecord } from '@stark-ballot/validation/unknown-value-guards';
import { addHexPrefix, isValidHexString, normalizeHexString } from '@stark-ballot/crypto-primitives';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import type { FinalizationId } from '@stark-ballot/application/finalize/finalization-types';
import { asSessionId, type SessionId } from '@stark-ballot/domain/types/identifiers';
import { SAFE_VERIFIER_SEGMENT_PATTERN } from '@stark-ballot/validation/safe-verifier-segment';

export const VERIFICATION_WORK_RECORD_TYPE = 'verification-work' as const;

export interface VerificationWorkMessage {
  recordType: typeof VERIFICATION_WORK_RECORD_TYPE;
  sessionId: SessionId;
  finalizationId: FinalizationId;
  queuedAtMs: number;
  bundleKey: string;
  expectedImageId: string;
}

const MESSAGE_KEYS = new Set([
  'recordType',
  'sessionId',
  'finalizationId',
  'queuedAtMs',
  'bundleKey',
  'expectedImageId',
]);

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function parseSafeSegment(value: unknown, label: string): string {
  const parsed = parseNonEmptyString(value, label);
  if (!SAFE_VERIFIER_SEGMENT_PATTERN.test(parsed)) {
    throw new Error(`${label} must be a safe single path segment`);
  }
  return parsed;
}

function parseInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function parseExpectedImageId(value: unknown): string {
  const normalized = addHexPrefix(normalizeHexString(parseNonEmptyString(value, 'expectedImageId')));
  if (!isValidHexString(normalized, 32)) {
    throw new Error('expectedImageId must be a 32-byte hex string');
  }
  return normalized;
}

export function parseVerificationWorkMessage(value: unknown): VerificationWorkMessage {
  if (!isRecord(value)) {
    throw new Error('verification work message must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!MESSAGE_KEYS.has(key)) {
      throw new Error(`verification work message contains unsupported field ${key}`);
    }
  }
  if (value['recordType'] !== VERIFICATION_WORK_RECORD_TYPE) {
    throw new Error(`verification work recordType must be ${VERIFICATION_WORK_RECORD_TYPE}`);
  }
  return {
    recordType: VERIFICATION_WORK_RECORD_TYPE,
    sessionId: asSessionId(parseSafeSegment(value['sessionId'], 'sessionId')),
    finalizationId: asFinalizationId(parseSafeSegment(value['finalizationId'], 'finalizationId')),
    queuedAtMs: parseInteger(value['queuedAtMs'], 'queuedAtMs'),
    bundleKey: parseNonEmptyString(value['bundleKey'], 'bundleKey'),
    expectedImageId: parseExpectedImageId(value['expectedImageId']),
  };
}
