import type { SessionData } from '@/types/server';
import type { FileMockDiagnostics, SerializableSessionData } from './types';

export type FileMockCacheState = {
  sessions: Map<string, SessionData>;
  serializedSessions: Map<string, SerializableSessionData>;
  dirtySessionIds: Set<string>;
  cacheEnabled: boolean;
  cacheLimit: number;
  diagnostics: FileMockDiagnostics;
};

export function updateCacheDiagnostics(state: FileMockCacheState): void {
  state.diagnostics.cacheSize = state.sessions.size;
}

export function rebuildSessionCacheFromSerialized(
  state: FileMockCacheState,
  deserializeSession: (data: SerializableSessionData) => SessionData,
): void {
  state.sessions.clear();
  const limit = state.cacheLimit > 0 ? state.cacheLimit : Number.POSITIVE_INFINITY;
  if (limit === Number.POSITIVE_INFINITY) {
    for (const sessionData of state.serializedSessions.values()) {
      const session = deserializeSession(sessionData);
      state.sessions.set(session.sessionId, session);
    }
    updateCacheDiagnostics(state);
    return;
  }

  const ordered = Array.from(state.serializedSessions.values()).sort((a, b) => b.lastActivity - a.lastActivity);
  const slice = ordered.slice(0, limit);
  for (const sessionData of slice) {
    const session = deserializeSession(sessionData);
    state.sessions.set(session.sessionId, session);
  }
  updateCacheDiagnostics(state);
}

export function recordCacheAccess(
  state: FileMockCacheState,
  session: SessionData,
  serializeSession: (session: SessionData) => SerializableSessionData,
): void {
  if (!state.cacheEnabled || state.cacheLimit === 0) {
    state.sessions.set(session.sessionId, session);
    updateCacheDiagnostics(state);
    return;
  }

  if (state.sessions.has(session.sessionId)) {
    state.sessions.delete(session.sessionId);
  }
  state.sessions.set(session.sessionId, session);
  trimCache(state, serializeSession);
}

export function trimCache(
  state: FileMockCacheState,
  serializeSession: (session: SessionData) => SerializableSessionData,
): void {
  if (!state.cacheEnabled || state.cacheLimit === 0) {
    updateCacheDiagnostics(state);
    return;
  }

  while (state.sessions.size > state.cacheLimit) {
    const oldestEntry = state.sessions.keys().next();
    if (oldestEntry.done) {
      break;
    }
    const oldestKey = oldestEntry.value;
    const oldestSession = state.sessions.get(oldestKey);
    if (oldestSession && state.dirtySessionIds.has(oldestKey)) {
      state.serializedSessions.set(oldestKey, serializeSession(oldestSession));
      state.dirtySessionIds.delete(oldestKey);
    }
    state.sessions.delete(oldestKey);
    state.diagnostics.cacheEvictions += 1;
  }
  updateCacheDiagnostics(state);
}

export function snapshotCachedSessions(
  state: FileMockCacheState,
  serializeSession: (session: SessionData) => SerializableSessionData,
): void {
  for (const session of state.sessions.values()) {
    if (state.dirtySessionIds.has(session.sessionId)) {
      state.serializedSessions.set(session.sessionId, serializeSession(session));
    }
  }
}
