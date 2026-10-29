import { admitSessionIdentity } from './identity';
import { isValidHexString } from '@stark-ballot/crypto-primitives';
import { resolveCanonicalFinalizationPayload } from '@stark-ballot/web/finalize/client-finalization-result';
import { isValidVoteId } from '@stark-ballot/validation/vote-id';
import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import { VOTE_CHOICES } from '@stark-ballot/verification/shared/constants';
import type { SessionData, ServerIssuedSessionIdentity, PrivateOpening, CastReceipt } from './types';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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

function isExactArray(value: unknown, expected: unknown): boolean {
  if (!Array.isArray(value) || !Array.isArray(expected) || value.length !== expected.length) return false;
  return value.every((entry, index) => isDeepExact(entry, expected[index]));
}

function isExactRecord(value: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  const valueKeys = Object.keys(value);
  const expectedKeys = Object.keys(expected);
  if (valueKeys.length !== expectedKeys.length || valueKeys.some((key) => !hasOwn(expected, key))) return false;
  return valueKeys.every((key) => isDeepExact(value[key], expected[key]));
}

function isDeepExact(value: unknown, expected: unknown): boolean {
  if (Object.is(value, expected)) return true;
  if (Array.isArray(value) || Array.isArray(expected)) return isExactArray(value, expected);
  if (!isRecord(value) || !isRecord(expected)) return false;
  return isExactRecord(value, expected);
}

function admitPrivateOpening(value: Record<string, unknown>): PrivateOpening | null {
  if (!hasCompleteGroup(value, PRIVATE_OPENING_KEYS)) return null;
  if (!hasOwn(value, 'myVote')) return {};
  const myVote = VOTE_CHOICES.find((choice) => choice === value['myVote']);
  const myCommit = value['myCommit'];
  const myRand = value['myRand'];
  return myVote !== undefined && isHex32(myCommit) && isHex32(myRand) ? { myVote, myCommit, myRand } : null;
}

function admitCastReceipt(value: Record<string, unknown>): CastReceipt | null {
  if (!hasCompleteGroup(value, CAST_RECEIPT_KEYS)) return null;
  if (!hasOwn(value, 'voteId')) return {};
  const voteId = value['voteId'];
  const bulletinIndex = value['bulletinIndex'];
  const bulletinRootAtCast = value['bulletinRootAtCast'];
  return typeof voteId === 'string' &&
    isValidVoteId(voteId) &&
    isNonNegativeSafeInteger(bulletinIndex) &&
    isHex32(bulletinRootAtCast)
    ? { voteId, bulletinIndex, bulletinRootAtCast }
    : null;
}

function admitIdentity(value: Record<string, unknown>): ServerIssuedSessionIdentity | null {
  const sessionId = value['sessionId'];
  const capabilityToken = value['capabilityToken'];
  const electionId = value['electionId'];
  const electionConfigHash = value['electionConfigHash'];
  const logId = value['logId'];
  return typeof sessionId === 'string' &&
    isSafeVerifierSegment(sessionId) &&
    isNonEmptyString(capabilityToken) &&
    typeof electionId === 'string' &&
    UUID_V4_PATTERN.test(electionId) &&
    isHex32(electionConfigHash) &&
    isHex32(logId)
    ? { ...admitSessionIdentity({ sessionId, capabilityToken }), electionId, electionConfigHash, logId }
    : null;
}

export function admitStoredSessionData(value: unknown): SessionData | null {
  if (!isRecord(value) || !hasExactKeys(value, SESSION_RECORD_KEYS)) return null;
  const identity = admitIdentity(value);
  const opening = admitPrivateOpening(value);
  const receipt = admitCastReceipt(value);
  const lastActivity = value['lastActivity'];
  const expiresAt = value['expiresAt'];
  if (
    !identity ||
    !opening ||
    !receipt ||
    !isNonNegativeSafeInteger(lastActivity) ||
    !isNonNegativeSafeInteger(expiresAt) ||
    expiresAt < lastActivity
  )
    return null;
  const base = { ...identity, ...opening, ...receipt, lastActivity, expiresAt };
  const phase = value['phase'];
  switch (phase) {
    case 'voting':
    case 'finalizing':
      if (hasOwn(value, 'finalizeResult') || hasOwn(value, 'verificationRequestedAt')) return null;
      return { ...base, phase };
    case 'verifying': {
      const finalizeResult = resolveCanonicalFinalizationPayload(value['finalizeResult']);
      if (!finalizeResult || !isDeepExact(value['finalizeResult'], stripUndefined(finalizeResult))) return null;
      if (!hasOwn(value, 'verificationRequestedAt')) return { ...base, phase, finalizeResult };
      const verificationRequestedAt = value['verificationRequestedAt'];
      if (!isNonNegativeSafeInteger(verificationRequestedAt)) return null;
      return { ...base, phase, finalizeResult, verificationRequestedAt };
    }
    default:
      return null;
  }
}
