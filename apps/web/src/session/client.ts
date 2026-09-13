import type { ClientFinalizationSnapshot } from '@stark-ballot/web/finalize/client-finalization-result';
import type { ServerIssuedSessionIdentity, SessionData, SessionPhase, VoteChoice } from './types';
import { admitStoredSessionData } from './storageAdmission';
import {
  clearStoredSessionData,
  hasClientStorageSupport,
  notifyStoredSessionChange,
  SESSION_LOCK_KEY,
  SESSION_STORAGE_KEY as SESSION_STORAGE_KEY_VALUE,
} from './storage';

export const SESSION_PHASE_TIMEOUTS_MS: Record<SessionPhase, number> = {
  voting: 30 * 60 * 1000,
  finalizing: 30 * 60 * 1000,
  verifying: 24 * 60 * 60 * 1000,
};

export const SESSION_ACTIVE_TIMEOUT_MS = SESSION_PHASE_TIMEOUTS_MS.voting;
export const SESSION_VERIFICATION_TIMEOUT_MS = SESSION_PHASE_TIMEOUTS_MS.verifying;
export const SESSION_HEARTBEAT_INTERVAL_MS = 60 * 1000;
export const SESSION_STORAGE_KEY = SESSION_STORAGE_KEY_VALUE;

export type SessionIdentity = Pick<SessionData, 'sessionId' | 'capabilityToken'>;

type SessionPatch = {
  phase?: SessionPhase;
  myVote?: VoteChoice | undefined;
  myCommit?: string | undefined;
  myRand?: string | undefined;
  voteId?: string | undefined;
  bulletinIndex?: number | undefined;
  bulletinRootAtCast?: string | undefined;
  verificationRequestedAt?: number | undefined;
  finalizeResult?: ClientFinalizationSnapshot | undefined;
};

const SESSION_PATCH_KEYS = new Set<keyof SessionPatch>([
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
const OPTIONAL_PATCH_KEYS = [
  'myVote',
  'myCommit',
  'myRand',
  'voteId',
  'bulletinIndex',
  'bulletinRootAtCast',
  'verificationRequestedAt',
  'finalizeResult',
] as const;

function hasStorageSupport(): boolean {
  return hasClientStorageSupport();
}

function computeExpiry(phase: SessionPhase, now: number = Date.now()): number {
  return now + SESSION_PHASE_TIMEOUTS_MS[phase];
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseSessionIdentity(value: unknown): SessionIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !hasOwn(record, 'sessionId') ||
    !hasOwn(record, 'capabilityToken') ||
    typeof record['sessionId'] !== 'string' ||
    record['sessionId'].length === 0 ||
    typeof record['capabilityToken'] !== 'string' ||
    record['capabilityToken'].length === 0
  ) {
    return null;
  }
  return {
    sessionId: record['sessionId'],
    capabilityToken: record['capabilityToken'],
  };
}

function toSessionIdentity(
  value?: Pick<SessionData, 'sessionId' | 'capabilityToken'> | SessionIdentity | null,
): SessionIdentity | null {
  if (!value) {
    return null;
  }
  return parseSessionIdentity({
    sessionId: value.sessionId,
    capabilityToken: value.capabilityToken,
  });
}

function serializeAdmittedSession(value: unknown): { data: SessionData; json: string } | null {
  try {
    const json = JSON.stringify(value);
    const parsed: unknown = JSON.parse(json);
    const data = admitStoredSessionData(parsed);
    return data ? { data, json } : null;
  } catch {
    return null;
  }
}

function safeParseSession(): SessionData | null {
  if (!hasStorageSupport()) {
    return null;
  }

  const storedData = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!storedData) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(storedData);
    const admitted = admitStoredSessionData(parsed);
    if (admitted) {
      return admitted;
    }
  } catch {
    // Invalid JSON is handled by the same fail-closed clear below.
  }

  clearStoredSessionData({ clearKnowledge: true, clearLock: true });
  return null;
}

function readSessionLock(): SessionIdentity | null {
  if (!hasStorageSupport()) {
    return null;
  }

  const storedLock = sessionStorage.getItem(SESSION_LOCK_KEY);
  if (!storedLock) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(storedLock);
    const identity = parseSessionIdentity(parsed);
    if (identity) {
      return identity;
    }
  } catch {
    // Invalid JSON is handled by clearing the lock below.
  }

  sessionStorage.removeItem(SESSION_LOCK_KEY);
  return null;
}

function writeSessionLock(identity: SessionIdentity): void {
  if (!hasStorageSupport()) {
    return;
  }

  try {
    sessionStorage.setItem(SESSION_LOCK_KEY, JSON.stringify(identity));
  } catch {
    // Ignore storage errors.
  }
}

function isSameSessionIdentity(left: SessionIdentity, right: SessionIdentity): boolean {
  return left.sessionId === right.sessionId && left.capabilityToken === right.capabilityToken;
}

function isSessionLockMismatch(session: SessionData | null, lock: SessionIdentity | null): boolean {
  if (!lock) {
    return false;
  }
  if (!session) {
    return true;
  }
  return !isSameSessionIdentity(session, {
    sessionId: lock.sessionId,
    capabilityToken: lock.capabilityToken,
  });
}

function readSessionForAccess({
  createLockIfMissing = true,
  expectedIdentity,
}: { createLockIfMissing?: boolean; expectedIdentity?: SessionIdentity | null } = {}): SessionData | null {
  const session = safeParseSession();
  if (!session) {
    return null;
  }

  const sessionIdentity = toSessionIdentity(session);
  if (expectedIdentity && sessionIdentity && !isSameSessionIdentity(sessionIdentity, expectedIdentity)) {
    return null;
  }

  const lock = readSessionLock();
  if (isSessionLockMismatch(session, lock)) {
    return null;
  }

  if (!lock && createLockIfMissing) {
    writeSessionLock({
      sessionId: session.sessionId,
      capabilityToken: session.capabilityToken,
    });
  }

  return session;
}

function writeSessionData(data: SessionData): void {
  if (!hasStorageSupport()) {
    return;
  }

  const serialized = serializeAdmittedSession(data);
  if (!serialized) {
    throw new Error('Invalid browser session state');
  }
  localStorage.setItem(SESSION_STORAGE_KEY, serialized.json);
}

function isExpired(session: SessionData, now: number = Date.now()): boolean {
  return now > session.expiresAt;
}

function applySessionPatch(current: SessionData, patch: SessionPatch, now: number): SessionData {
  if (Object.keys(patch).some((key) => !SESSION_PATCH_KEYS.has(key as keyof SessionPatch))) {
    throw new Error('Invalid browser session patch');
  }

  const candidate: Record<string, unknown> = { ...current };
  for (const key of OPTIONAL_PATCH_KEYS) {
    if (!hasOwn(patch, key)) {
      continue;
    }
    const value = patch[key];
    if (value === undefined) {
      delete candidate[key];
    } else {
      candidate[key] = value;
    }
  }

  if (hasOwn(patch, 'phase')) {
    candidate['phase'] = patch.phase;
  } else if (hasOwn(patch, 'finalizeResult') && patch.finalizeResult !== undefined) {
    candidate['phase'] = 'verifying';
  }

  const phase = candidate['phase'];
  if (phase !== 'voting' && phase !== 'finalizing' && phase !== 'verifying') {
    throw new Error('Invalid browser session phase');
  }
  candidate['lastActivity'] = now;
  candidate['expiresAt'] = computeExpiry(phase, now);

  const admitted = serializeAdmittedSession(candidate)?.data;
  if (!admitted) {
    throw new Error('Invalid browser session state');
  }
  return admitted;
}

export function initializeSession(identity: ServerIssuedSessionIdentity): string {
  const now = Date.now();
  const serialized = serializeAdmittedSession({
    ...identity,
    phase: 'voting',
    lastActivity: now,
    expiresAt: computeExpiry('voting', now),
  });
  if (!serialized) {
    throw new Error('Invalid server-issued session identity');
  }

  if (hasStorageSupport()) {
    localStorage.setItem(SESSION_STORAGE_KEY, serialized.json);
    writeSessionLock({
      sessionId: serialized.data.sessionId,
      capabilityToken: serialized.data.capabilityToken,
    });
    notifyStoredSessionChange();
  }
  return serialized.data.sessionId;
}

export function captureSessionIdentity(
  sessionOverride?: Pick<SessionData, 'sessionId' | 'capabilityToken'> | null,
): SessionIdentity | null {
  return toSessionIdentity(sessionOverride ?? getSessionData());
}

export function clearSession(): void {
  try {
    if (hasStorageSupport()) {
      clearStoredSessionData({ clearKnowledge: true, clearLock: true });
    }
  } catch {
    // Ignore storage errors.
  }
}

function refreshSession(session: SessionData): void {
  if (isExpired(session)) {
    clearSession();
    return;
  }

  const now = Date.now();
  writeSessionData({
    ...session,
    lastActivity: now,
    expiresAt: computeExpiry(session.phase, now),
  });
}

export function updateLastActivity(): void {
  const session = readSessionForAccess();
  if (session) {
    refreshSession(session);
  }
}

export function updateLastActivityForIdentity(expectedIdentity: SessionIdentity | null): void {
  if (!expectedIdentity) {
    return;
  }
  const session = readSessionForAccess({ expectedIdentity });
  if (session) {
    refreshSession(session);
  }
}

export function getSessionData(): SessionData | null {
  const session = readSessionForAccess();
  if (!session) {
    return null;
  }
  if (isExpired(session)) {
    clearSession();
    return null;
  }
  return session;
}

export function getSessionDataForIdentity(expectedIdentity: SessionIdentity | null): SessionData | null {
  if (!expectedIdentity) {
    return null;
  }
  const session = readSessionForAccess({ expectedIdentity });
  if (!session) {
    return null;
  }
  if (isExpired(session)) {
    clearSession();
    return null;
  }
  return session;
}

export function saveSessionData(data: SessionPatch): void {
  const session = readSessionForAccess();
  if (!session) {
    return;
  }
  if (isExpired(session)) {
    clearSession();
    return;
  }
  writeSessionData(applySessionPatch(session, data, Date.now()));
}

export function saveSessionDataForIdentity(expectedIdentity: SessionIdentity | null, data: SessionPatch): void {
  if (!expectedIdentity) {
    return;
  }
  const session = readSessionForAccess({ expectedIdentity });
  if (!session) {
    return;
  }
  if (isExpired(session)) {
    clearSession();
    return;
  }
  writeSessionData(applySessionPatch(session, data, Date.now()));
}

/**
 * Returns true when the current tab has a locked session and localStorage was
 * replaced with another one.
 */
export function isSessionReplaced(): boolean {
  return isSessionLockMismatch(safeParseSession(), readSessionLock());
}

export function isSessionReplacedForIdentity(expectedIdentity: SessionIdentity | null): boolean {
  if (!expectedIdentity) {
    return false;
  }
  const currentIdentity = toSessionIdentity(safeParseSession());
  if (!currentIdentity) {
    return readSessionLock() !== null;
  }
  return !isSameSessionIdentity(currentIdentity, expectedIdentity);
}
