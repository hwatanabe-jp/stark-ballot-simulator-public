import type { SessionData, SessionPhase } from './types';
import { SESSION_CAPABILITY_HEADER, SESSION_ID_HEADER } from './capability';
import { resolveCanonicalFinalizationPayload } from '@/lib/finalize/client-finalization-result';
import { isCurrentContractGeneration, resolveCurrentContractGeneration } from '@/lib/contract';
import {
  clearStoredSessionData,
  ensureClientStorageSchema,
  hasClientStorageSupport,
  SESSION_LOCK_KEY,
  SESSION_STORAGE_KEY as SESSION_STORAGE_KEY_VALUE,
} from './storageSchema';

export const SESSION_PHASE_TIMEOUTS_MS: Record<SessionPhase, number> = {
  voting: 30 * 60 * 1000, // 30 minutes to cover vote + aggregation latency
  finalizing: 30 * 60 * 1000,
  verifying: 24 * 60 * 60 * 1000, // 24 hours to allow post-finalization auditing
};

export const SESSION_ACTIVE_TIMEOUT_MS = SESSION_PHASE_TIMEOUTS_MS.voting;
export const SESSION_VERIFICATION_TIMEOUT_MS = SESSION_PHASE_TIMEOUTS_MS.verifying;

// Legacy export retained for backward compatibility with existing tests/imports
export const SESSION_TIMEOUT_MS = SESSION_ACTIVE_TIMEOUT_MS;

export const SESSION_HEARTBEAT_INTERVAL_MS = 60 * 1000; // 1 minute keep-alive cadence

export const SESSION_STORAGE_KEY = SESSION_STORAGE_KEY_VALUE;
const DEFAULT_PHASE: SessionPhase = 'voting';
type StoredSessionData = Omit<SessionData, 'finalizeResult'> & { finalizeResult?: unknown };

export type SessionIdentity = Pick<SessionData, 'sessionId' | 'capabilityToken'>;

function hasStorageSupport(): boolean {
  return hasClientStorageSupport();
}

function ensureStorageSchema(): void {
  ensureClientStorageSchema();
}

function sanitizeSessionData(session: SessionData | StoredSessionData): SessionData {
  const { finalizeResult, ...sessionWithoutFinalizeResult } = session;
  const baseSession: SessionData = { ...sessionWithoutFinalizeResult };

  if (finalizeResult === undefined && session.phase !== 'verifying' && session.verificationRequestedAt === undefined) {
    return baseSession;
  }

  const canonicalFinalizeResult = resolveCanonicalFinalizationPayload(finalizeResult);
  if (canonicalFinalizeResult) {
    return {
      ...baseSession,
      finalizeResult: canonicalFinalizeResult,
    };
  }

  const sanitized: SessionData = { ...baseSession };
  delete sanitized.finalizeResult;
  delete sanitized.verificationRequestedAt;
  if (sanitized.phase === 'verifying') {
    sanitized.phase = DEFAULT_PHASE;
    delete sanitized.expiresAt;
  }
  return sanitized;
}

function resolvePhase(data?: Partial<SessionData>): SessionPhase {
  if (!data?.phase) {
    return DEFAULT_PHASE;
  }
  return data.phase;
}

function computeExpiry(phase: SessionPhase, now: number = Date.now()): number {
  return now + SESSION_PHASE_TIMEOUTS_MS[phase];
}

function parseSessionIdentity(value: unknown): SessionIdentity | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const sessionId = record.sessionId;
  const capabilityToken = record.capabilityToken;
  if (
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    typeof capabilityToken !== 'string' ||
    capabilityToken.length === 0
  ) {
    return null;
  }
  return { sessionId, capabilityToken };
}

function toSessionIdentity(
  value?: Pick<SessionData, 'sessionId' | 'capabilityToken'> | SessionIdentity | null,
): SessionIdentity | null {
  if (!value) {
    return null;
  }
  return parseSessionIdentity(value);
}

function safeParseSessionRaw(): SessionData | null {
  if (!hasStorageSupport()) {
    return null;
  }

  const storedData = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!storedData) {
    return null;
  }
  try {
    const parsed = JSON.parse(storedData) as unknown;
    if (!isStoredSessionData(parsed)) {
      clearStoredSessionData({ clearKnowledge: true, clearLock: true });
      return null;
    }
    return sanitizeSessionData(parsed);
  } catch {
    clearStoredSessionData({ clearKnowledge: true, clearLock: true });
    return null;
  }
}

function safeParseSession(): SessionData | null {
  ensureStorageSchema();
  return safeParseSessionRaw();
}

function isStoredSessionData(value: unknown): value is StoredSessionData {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === 'string' &&
    record.sessionId.length > 0 &&
    typeof record.capabilityToken === 'string' &&
    record.capabilityToken.length > 0 &&
    typeof record.contractGeneration === 'string' &&
    isCurrentContractGeneration(record.contractGeneration) &&
    typeof record.lastActivity === 'number' &&
    Number.isFinite(record.lastActivity) &&
    (record.verificationRequestedAt === undefined ||
      (typeof record.verificationRequestedAt === 'number' && Number.isFinite(record.verificationRequestedAt)))
  );
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
    const parsed = JSON.parse(storedLock) as unknown;
    const identity = parseSessionIdentity(parsed);
    if (!identity) {
      sessionStorage.removeItem(SESSION_LOCK_KEY);
      return null;
    }
    return identity;
  } catch {
    sessionStorage.removeItem(SESSION_LOCK_KEY);
    return null;
  }
}

function writeSessionLock(identity: SessionIdentity): void {
  if (!hasStorageSupport()) {
    return;
  }

  try {
    sessionStorage.setItem(SESSION_LOCK_KEY, JSON.stringify(identity));
  } catch {
    // Ignore storage errors
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
  const sessionIdentity: SessionIdentity = {
    sessionId: session.sessionId,
    capabilityToken: session.capabilityToken,
  };
  return !isSameSessionIdentity(sessionIdentity, lock);
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
  ensureStorageSchema();
  if (!hasStorageSupport()) {
    return;
  }
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sanitizeSessionData(data)));
}

function isExpired(session: SessionData, now: number = Date.now()): boolean {
  const phase = resolvePhase(session);
  const expiresAt = session.expiresAt ?? session.lastActivity + SESSION_PHASE_TIMEOUTS_MS[phase];
  return now > expiresAt;
}

function normalizeSessionData(session: SessionData, now: number = Date.now()): SessionData {
  const phase = resolvePhase(session);
  const lastActivity = typeof session.lastActivity === 'number' ? session.lastActivity : now;
  const expiresAt = session.expiresAt ?? computeExpiry(phase, lastActivity);

  return {
    ...session,
    phase,
    lastActivity,
    expiresAt,
  };
}

function determineNextPhase(current: SessionData, patch: Partial<SessionData>): SessionPhase {
  if (patch.phase) {
    if (patch.phase !== 'verifying') {
      return resolvePhase(patch);
    }
    if (resolveCanonicalFinalizationPayload(patch.finalizeResult) || current.finalizeResult !== undefined) {
      return 'verifying';
    }
    return resolvePhase(current);
  }
  if (resolveCanonicalFinalizationPayload(patch.finalizeResult)) {
    return 'verifying';
  }
  return resolvePhase(current);
}

function hasOwnPatchKey<T extends object>(value: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function applySessionPatch(current: SessionData, patch: Partial<SessionData>, now: number): SessionData {
  const hasFinalizeResultPatch = hasOwnPatchKey(patch, 'finalizeResult');
  const patchedFinalizeResult = hasFinalizeResultPatch
    ? (resolveCanonicalFinalizationPayload(patch.finalizeResult) ?? undefined)
    : undefined;
  const nextPhase = determineNextPhase(current, patch);

  const updated: SessionData = {
    ...current,
    ...patch,
    phase: nextPhase,
    lastActivity: now,
    expiresAt: computeExpiry(nextPhase, now),
  };

  if (hasFinalizeResultPatch) {
    if (patchedFinalizeResult) {
      updated.finalizeResult = patchedFinalizeResult;
    } else if (patch.finalizeResult === undefined || current.finalizeResult === undefined) {
      delete updated.finalizeResult;
    } else {
      updated.finalizeResult = current.finalizeResult;
    }
  }

  return sanitizeSessionData(updated);
}

export function generateSessionId(
  initialSessionId: string | undefined,
  capabilityToken: string,
  contractGeneration: string = resolveCurrentContractGeneration(),
): string {
  ensureStorageSchema();
  const sessionId = initialSessionId ?? crypto.randomUUID();
  const normalizedCapabilityToken = capabilityToken.trim();
  const normalizedContractGeneration = contractGeneration.trim();
  if (!normalizedCapabilityToken) {
    throw new Error('capabilityToken is required');
  }
  if (!normalizedContractGeneration) {
    throw new Error('contractGeneration is required');
  }
  const now = Date.now();
  const phase = DEFAULT_PHASE;
  const sessionData: SessionData = {
    sessionId,
    capabilityToken: normalizedCapabilityToken,
    contractGeneration: normalizedContractGeneration,
    lastActivity: now,
    expiresAt: computeExpiry(phase, now),
    phase,
  };

  writeSessionData(sessionData);
  writeSessionLock({
    sessionId: sessionData.sessionId,
    capabilityToken: sessionData.capabilityToken,
  });
  return sessionId;
}

export function captureSessionIdentity(
  sessionOverride?: Pick<SessionData, 'sessionId' | 'capabilityToken'> | null,
): SessionIdentity | null {
  return toSessionIdentity(sessionOverride ?? getSessionData());
}

export function checkTimeout(): boolean {
  const session = readSessionForAccess();
  if (!session) {
    return true;
  }

  if (isExpired(session)) {
    clearSession();
    return true;
  }

  return false;
}

export function clearSession(): void {
  try {
    ensureStorageSchema();
    if (!hasStorageSupport()) {
      return;
    }
    clearStoredSessionData({ clearKnowledge: true, clearLock: true });
  } catch {
    // Ignore storage errors (e.g., private mode)
  }
}

export function updateLastActivity(): void {
  const session = readSessionForAccess();
  if (!session) {
    return;
  }

  if (isExpired(session)) {
    clearSession();
    return;
  }

  const now = Date.now();
  const phase = resolvePhase(session);
  const updated: SessionData = {
    ...session,
    phase,
    lastActivity: now,
    expiresAt: computeExpiry(phase, now),
  };

  writeSessionData(updated);
}

export function updateLastActivityForIdentity(expectedIdentity: SessionIdentity | null): void {
  const session = readSessionForAccess({ expectedIdentity });
  if (!session) {
    return;
  }

  if (isExpired(session)) {
    clearSession();
    return;
  }

  const now = Date.now();
  const phase = resolvePhase(session);
  const updated: SessionData = {
    ...session,
    phase,
    lastActivity: now,
    expiresAt: computeExpiry(phase, now),
  };

  writeSessionData(updated);
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

  const normalized = normalizeSessionData(session);
  writeSessionData(normalized);
  return normalized;
}

export function getSessionDataForIdentity(expectedIdentity: SessionIdentity | null): SessionData | null {
  const session = readSessionForAccess({ expectedIdentity });
  if (!session) {
    return null;
  }

  if (isExpired(session)) {
    clearSession();
    return null;
  }

  const normalized = normalizeSessionData(session);
  writeSessionData(normalized);
  return normalized;
}

export function saveSessionData(data: Partial<SessionData>): void {
  const session = readSessionForAccess();
  if (!session) {
    return;
  }

  if (isExpired(session)) {
    clearSession();
    return;
  }

  const now = Date.now();
  const current = normalizeSessionData(session, now);
  const updated = applySessionPatch(current, data, now);

  writeSessionData(updated);
}

export function saveSessionDataForIdentity(expectedIdentity: SessionIdentity | null, data: Partial<SessionData>): void {
  const session = readSessionForAccess({ expectedIdentity });
  if (!session) {
    return;
  }

  if (isExpired(session)) {
    clearSession();
    return;
  }

  const now = Date.now();
  const current = normalizeSessionData(session, now);
  const updated = applySessionPatch(current, data, now);

  writeSessionData(updated);
}

/**
 * Returns true when the current tab has a locked session and localStorage was replaced with another one.
 */
export function isSessionReplaced(): boolean {
  const session = safeParseSession();
  const lock = readSessionLock();
  return isSessionLockMismatch(session, lock);
}

export function isSessionReplacedForIdentity(expectedIdentity: SessionIdentity | null): boolean {
  if (!expectedIdentity) {
    return false;
  }
  const session = safeParseSession();
  const currentIdentity = toSessionIdentity(session);
  if (!currentIdentity) {
    return readSessionLock() !== null;
  }
  return !isSameSessionIdentity(currentIdentity, expectedIdentity);
}

/**
 * Build API auth headers for the current session.
 */
export function getSessionAuthHeaders(
  sessionOverride?: Pick<SessionData, 'sessionId' | 'capabilityToken'> | null,
): Record<string, string> {
  const session = sessionOverride ?? getSessionData();
  if (!session?.sessionId || !session.capabilityToken) {
    return {};
  }

  return {
    [SESSION_ID_HEADER]: session.sessionId,
    [SESSION_CAPABILITY_HEADER]: session.capabilityToken,
  };
}
