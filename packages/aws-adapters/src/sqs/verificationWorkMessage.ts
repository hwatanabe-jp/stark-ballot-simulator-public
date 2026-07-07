import { addHexPrefix, isValidHexString, normalizeHexString } from '@stark-ballot/domain/utils/hex';
import { SAFE_VERIFIER_SEGMENT_PATTERN } from '@stark-ballot/validation/safe-verifier-segment';

export const VERIFICATION_WORK_MESSAGE_VERSION = 'v1' as const;

export interface VerificationWorkMessage {
  messageVersion: typeof VERIFICATION_WORK_MESSAGE_VERSION;
  sessionId: string;
  executionId: string;
  queuedAt: number;
  bundleKey: string;
  expectedImageId: string;
}

const MESSAGE_KEYS = new Set([
  'messageVersion',
  'sessionId',
  'executionId',
  'queuedAt',
  'bundleKey',
  'expectedImageId',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  if (value['messageVersion'] !== VERIFICATION_WORK_MESSAGE_VERSION) {
    throw new Error(`verification work message version must be ${VERIFICATION_WORK_MESSAGE_VERSION}`);
  }
  return {
    messageVersion: VERIFICATION_WORK_MESSAGE_VERSION,
    sessionId: parseSafeSegment(value['sessionId'], 'sessionId'),
    executionId: parseSafeSegment(value['executionId'], 'executionId'),
    queuedAt: parseInteger(value['queuedAt'], 'queuedAt'),
    bundleKey: parseNonEmptyString(value['bundleKey'], 'bundleKey'),
    expectedImageId: parseExpectedImageId(value['expectedImageId']),
  };
}
