import { isValidHexString } from '@stark-ballot/crypto-primitives';
import { resolveCanonicalFinalizationPayload } from '@stark-ballot/web/finalize/client-finalization-result';
import { isValidVoteId } from '@stark-ballot/web/vote/voteIdValidation';
import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import type { SessionData, VoteChoice } from './types';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VOTE_CHOICES = new Set<VoteChoice>(['A', 'B', 'C', 'D', 'E']);
const SESSION_RECORD_KEYS = new Set([
  'sessionId',
  'capabilityToken',
  'electionId',
  'electionConfigHash',
  'logId',
  'lastActivity',
  'expiresAt',
  'phase',
  'myVote',
  'myCommit',
  'myRand',
  'voteId',
  'bulletinIndex',
  'bulletinRootAtCast',
  'verificationRequestedAt',
  'finalizeResult',
]);
const PRIVATE_OPENING_KEYS = ['myVote', 'myCommit', 'myRand'] as const;
const CAST_RECEIPT_KEYS = ['voteId', 'bulletinIndex', 'bulletinRootAtCast'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isHex32(value: unknown): value is string {
  return typeof value === 'string' && isValidHexString(value, 32);
}

function hasCompleteGroup(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const presentCount = keys.filter((key) => hasOwn(value, key)).length;
  return presentCount === 0 || presentCount === keys.length;
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, stripUndefined(entry)]),
  );
}

function isDeepExact(value: unknown, expected: unknown): boolean {
  if (Object.is(value, expected)) {
    return true;
  }
  if (Array.isArray(value) || Array.isArray(expected)) {
    if (!Array.isArray(value) || !Array.isArray(expected) || value.length !== expected.length) {
      return false;
    }
    return value.every((entry, index) => isDeepExact(entry, expected[index]));
  }
  if (!isRecord(value) || !isRecord(expected)) {
    return false;
  }
  const valueKeys = Object.keys(value);
  const expectedKeys = Object.keys(expected);
  if (valueKeys.length !== expectedKeys.length || valueKeys.some((key) => !hasOwn(expected, key))) {
    return false;
  }
  return valueKeys.every((key) => isDeepExact(value[key], expected[key]));
}

function hasValidPrivateOpening(value: Record<string, unknown>): boolean {
  if (!hasCompleteGroup(value, PRIVATE_OPENING_KEYS)) {
    return false;
  }
  if (!hasOwn(value, 'myVote')) {
    return true;
  }
  return VOTE_CHOICES.has(value['myVote'] as VoteChoice) && isHex32(value['myCommit']) && isHex32(value['myRand']);
}

function hasValidCastReceipt(value: Record<string, unknown>): boolean {
  if (!hasCompleteGroup(value, CAST_RECEIPT_KEYS)) {
    return false;
  }
  if (!hasOwn(value, 'voteId')) {
    return true;
  }
  return (
    typeof value['voteId'] === 'string' &&
    isValidVoteId(value['voteId']) &&
    typeof value['bulletinIndex'] === 'number' &&
    Number.isInteger(value['bulletinIndex']) &&
    value['bulletinIndex'] >= 0 &&
    isHex32(value['bulletinRootAtCast'])
  );
}

function hasValidIdentity(value: Record<string, unknown>): boolean {
  return (
    typeof value['sessionId'] === 'string' &&
    isSafeVerifierSegment(value['sessionId']) &&
    isNonEmptyString(value['capabilityToken']) &&
    typeof value['electionId'] === 'string' &&
    UUID_V4_PATTERN.test(value['electionId']) &&
    isHex32(value['electionConfigHash']) &&
    isHex32(value['logId'])
  );
}

function hasValidLifetime(value: Record<string, unknown>): boolean {
  return (
    isFiniteTimestamp(value['lastActivity']) &&
    isFiniteTimestamp(value['expiresAt']) &&
    value['expiresAt'] >= value['lastActivity']
  );
}

function hasExactFinalizationSnapshot(value: unknown): boolean {
  const canonical = resolveCanonicalFinalizationPayload(value);
  return canonical !== null && isDeepExact(value, stripUndefined(canonical));
}

export function admitStoredSessionData(value: unknown): SessionData | null {
  if (!isRecord(value) || !hasExactKeys(value, SESSION_RECORD_KEYS)) {
    return null;
  }
  if (
    !hasValidIdentity(value) ||
    !hasValidLifetime(value) ||
    !hasValidPrivateOpening(value) ||
    !hasValidCastReceipt(value)
  ) {
    return null;
  }

  switch (value['phase']) {
    case 'voting':
    case 'finalizing':
      if (hasOwn(value, 'finalizeResult') || hasOwn(value, 'verificationRequestedAt')) {
        return null;
      }
      return value as unknown as SessionData;
    case 'verifying':
      if (
        !hasOwn(value, 'finalizeResult') ||
        !hasExactFinalizationSnapshot(value['finalizeResult']) ||
        (hasOwn(value, 'verificationRequestedAt') && !isFiniteTimestamp(value['verificationRequestedAt']))
      ) {
        return null;
      }
      return value as unknown as SessionData;
    default:
      return null;
  }
}
