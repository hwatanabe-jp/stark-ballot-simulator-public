import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  captureSessionIdentity,
  generateSessionId,
  checkTimeout,
  clearSession,
  updateLastActivity,
  updateLastActivityForIdentity,
  getSessionData,
  getSessionDataForIdentity,
  saveSessionData,
  saveSessionDataForIdentity,
  isSessionReplaced,
  isSessionReplacedForIdentity,
  SESSION_TIMEOUT_MS,
  SESSION_ACTIVE_TIMEOUT_MS,
  SESSION_VERIFICATION_TIMEOUT_MS,
} from './client';
import type { SessionData } from './types';
import { resolveCanonicalFinalizationPayload } from '@/lib/finalize/client-finalization-result';
import { resolveCurrentContractGeneration } from '@/lib/contract';
import { getNumberProperty, getStringProperty, isRecord } from '@/lib/utils/guards';
import { createTestJournal } from '@/lib/testing/test-helpers';
import { SESSION_SCHEMA_VERSION } from './storageSchema';

const mockRandomUUID = vi.fn();
Object.defineProperty(global, 'crypto', {
  value: {
    randomUUID: mockRandomUUID,
  },
  writable: true,
});

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
});

function readStoredSession(): Record<string, unknown> {
  const raw = localStorageMock.getItem('starkBallotSession') || '{}';
  const payload: unknown = JSON.parse(raw);
  if (!isRecord(payload)) {
    throw new Error('Stored session is invalid');
  }
  return payload;
}

function buildCanonicalFinalizeResult(): NonNullable<SessionData['finalizeResult']> {
  const journal = createTestJournal({
    totalExpected: 1,
    validVotes: 1,
    missingIndices: 0,
    invalidIndices: 0,
    seenIndicesCount: 1,
  });

  const result = resolveCanonicalFinalizationPayload({
    tally: {
      counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
      totalVotes: 1,
      tamperedCount: 0,
    },
    imageId: '0x' + 'e'.repeat(64),
    journal,
  });

  if (!result) {
    throw new Error('Failed to build canonical finalize result');
  }

  return result;
}

describe('Session Management', () => {
  const now = new Date('2025-10-19T00:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    localStorageMock.clear();
    window.sessionStorage.clear();
    mockRandomUUID.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('generateSessionId', () => {
    it('generates and stores a new session with defaults', () => {
      const mockUuid = '123e4567-e89b-12d3-a456-426614174000';
      mockRandomUUID.mockReturnValue(mockUuid);

      const sessionId = generateSessionId(undefined, 'capability-token');

      expect(sessionId).toBe(mockUuid);
      const stored = readStoredSession();
      expect(getStringProperty(stored, 'sessionId')).toBe(mockUuid);
      expect(getStringProperty(stored, 'contractGeneration')).toBe(resolveCurrentContractGeneration());
      expect(getStringProperty(stored, 'phase')).toBe('voting');
      expect(getNumberProperty(stored, 'lastActivity')).toBe(now.getTime());
      expect(getNumberProperty(stored, 'expiresAt')).toBe(now.getTime() + SESSION_ACTIVE_TIMEOUT_MS);
    });

    it('accepts a server-provided session ID', () => {
      generateSessionId('server-session-id', 'capability-token');

      const stored = readStoredSession();
      expect(getStringProperty(stored, 'sessionId')).toBe('server-session-id');
    });

    it('throws when capability token is empty', () => {
      expect(() => generateSessionId('server-session-id', '')).toThrow('capabilityToken is required');
    });
  });

  describe('checkTimeout', () => {
    it('returns false when session is active', () => {
      generateSessionId('active-session', 'capability-token');

      expect(checkTimeout()).toBe(false);
    });

    it('returns true and clears storage when session expired', () => {
      localStorageMock.setItem(
        'starkBallotSession',
        JSON.stringify({
          sessionId: 'expired-session',
          contractGeneration: resolveCurrentContractGeneration(),
          lastActivity: now.getTime() - SESSION_TIMEOUT_MS - 1000,
        }),
      );

      expect(checkTimeout()).toBe(true);
      expect(localStorageMock.getItem('starkBallotSession')).toBeNull();
    });

    it('returns true when no session exists', () => {
      expect(checkTimeout()).toBe(true);
    });
  });

  describe('clearSession', () => {
    it('removes session data', () => {
      generateSessionId('clear-me', 'capability-token');

      clearSession();

      expect(localStorageMock.getItem('starkBallotSession')).toBeNull();
    });
  });

  describe('updateLastActivity', () => {
    it('updates lastActivity and extends expiry', () => {
      generateSessionId('heartbeat', 'capability-token');

      vi.advanceTimersByTime(15_000);
      updateLastActivity();

      const stored = readStoredSession();
      const expectedNow = now.getTime() + 15_000;
      expect(getNumberProperty(stored, 'lastActivity')).toBe(expectedNow);
      expect(getNumberProperty(stored, 'expiresAt')).toBe(expectedNow + SESSION_ACTIVE_TIMEOUT_MS);
    });

    it('preserves other fields while updating activity', () => {
      generateSessionId('preserve', 'capability-token');
      saveSessionData({ myVote: 'A', myCommit: 'commit', myRand: 'rand' });

      vi.advanceTimersByTime(5_000);
      updateLastActivity();

      const stored = readStoredSession();
      expect(getStringProperty(stored, 'myVote')).toBe('A');
      expect(getStringProperty(stored, 'myCommit')).toBe('commit');
      expect(getStringProperty(stored, 'myRand')).toBe('rand');
    });
  });

  describe('getSessionData', () => {
    it('returns normalized session data when active', () => {
      generateSessionId('normalize', 'capability-token');
      const data = getSessionData();

      expect(data).not.toBeNull();
      expect(data?.sessionId).toBe('normalize');
      expect(data?.phase).toBe('voting');
      expect(data?.expiresAt).toBe(now.getTime() + SESSION_ACTIVE_TIMEOUT_MS);
    });

    it('returns null when session expired', () => {
      localStorageMock.setItem(
        'starkBallotSession',
        JSON.stringify({
          sessionId: 'expired',
          contractGeneration: resolveCurrentContractGeneration(),
          capabilityToken: 'capability-token',
          lastActivity: now.getTime() - SESSION_TIMEOUT_MS - 1000,
        }),
      );

      expect(getSessionData()).toBeNull();
      expect(localStorageMock.getItem('starkBallotSession')).toBeNull();
    });

    it('clears generation-less browser-local sessions', () => {
      localStorageMock.setItem('starkBallotSessionSchemaVersion', SESSION_SCHEMA_VERSION);
      localStorageMock.setItem(
        'starkBallotSession',
        JSON.stringify({
          sessionId: 'legacy-session',
          capabilityToken: 'capability-token',
          lastActivity: now.getTime(),
        }),
      );
      localStorageMock.setItem(
        'stark-ballot-knowledge',
        JSON.stringify({
          sessionId: 'legacy-session',
          electionId: 'legacy-election',
        }),
      );

      expect(getSessionData()).toBeNull();
      expect(localStorageMock.getItem('starkBallotSession')).toBeNull();
      expect(localStorageMock.getItem('stark-ballot-knowledge')).toBeNull();
    });

    it('clears the tab lock when generation-less browser-local sessions are rejected', () => {
      generateSessionId('legacy-session', 'capability-token');
      const expectedIdentity = captureSessionIdentity(getSessionData());
      localStorageMock.setItem('starkBallotSessionSchemaVersion', SESSION_SCHEMA_VERSION);
      localStorageMock.setItem(
        'starkBallotSession',
        JSON.stringify({
          sessionId: 'legacy-session',
          capabilityToken: 'capability-token',
          lastActivity: now.getTime(),
        }),
      );

      expect(getSessionData()).toBeNull();
      expect(window.sessionStorage.getItem('starkBallotSessionLock')).toBeNull();
      expect(isSessionReplaced()).toBe(false);
      expect(isSessionReplacedForIdentity(expectedIdentity)).toBe(false);
    });

    it('clears stale browser-local artifacts when the storage schema version changes', () => {
      localStorageMock.setItem('starkBallotSessionSchemaVersion', 'stale-schema');
      localStorageMock.setItem(
        'starkBallotSession',
        JSON.stringify({
          sessionId: 'stale-session',
          contractGeneration: resolveCurrentContractGeneration(),
          capabilityToken: 'stale-capability',
          lastActivity: now.getTime(),
        }),
      );
      localStorageMock.setItem('stark-ballot-knowledge', JSON.stringify({ sessionId: 'stale-session' }));

      expect(getSessionData()).toBeNull();
      expect(localStorageMock.getItem('starkBallotSession')).toBeNull();
      expect(localStorageMock.getItem('stark-ballot-knowledge')).toBeNull();
      expect(localStorageMock.getItem('starkBallotSessionSchemaVersion')).not.toBe('stale-schema');
    });

    it('drops unsupported cached finalization snapshots and verification continuation markers', () => {
      generateSessionId('session-with-stale-result', 'capability-token');
      localStorageMock.setItem(
        'starkBallotSession',
        JSON.stringify({
          sessionId: 'session-with-stale-result',
          contractGeneration: resolveCurrentContractGeneration(),
          capabilityToken: 'capability-token',
          phase: 'verifying',
          lastActivity: now.getTime(),
          expiresAt: now.getTime() + SESSION_VERIFICATION_TIMEOUT_MS,
          verificationRequestedAt: now.getTime(),
          finalizeResult: {
            tally: {
              counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
              totalVotes: 1,
              tamperedCount: 0,
            },
            imageId: '0x' + '1'.repeat(64),
          },
        }),
      );

      const session = getSessionData();
      expect(session).not.toBeNull();
      expect(session?.finalizeResult).toBeUndefined();
      expect(session?.verificationRequestedAt).toBeUndefined();
      expect(session?.phase).toBe('voting');
      expect(session?.expiresAt).toBe(now.getTime() + SESSION_ACTIVE_TIMEOUT_MS);

      const stored = readStoredSession();
      expect(stored.finalizeResult).toBeUndefined();
      expect(stored.verificationRequestedAt).toBeUndefined();
      expect(getStringProperty(stored, 'phase')).toBe('voting');
      expect(getNumberProperty(stored, 'expiresAt')).toBe(now.getTime() + SESSION_ACTIVE_TIMEOUT_MS);
    });

    it('drops cached journal-only finalization snapshots instead of rebuilding browser-local tally state', () => {
      generateSessionId('session-with-journal-only-result', 'capability-token');
      localStorageMock.setItem(
        'starkBallotSession',
        JSON.stringify({
          sessionId: 'session-with-journal-only-result',
          contractGeneration: resolveCurrentContractGeneration(),
          capabilityToken: 'capability-token',
          phase: 'verifying',
          lastActivity: now.getTime(),
          expiresAt: now.getTime() + SESSION_VERIFICATION_TIMEOUT_MS,
          verificationRequestedAt: now.getTime(),
          finalizeResult: {
            imageId: '0x' + 'e'.repeat(64),
            journal: createTestJournal({
              totalExpected: 1,
              validVotes: 1,
              missingIndices: 0,
              invalidIndices: 0,
              seenIndicesCount: 1,
            }),
          },
        }),
      );

      const session = getSessionData();
      expect(session).not.toBeNull();
      expect(session?.finalizeResult).toBeUndefined();
      expect(session?.verificationRequestedAt).toBeUndefined();
      expect(session?.phase).toBe('voting');
      expect(session?.expiresAt).toBe(now.getTime() + SESSION_ACTIVE_TIMEOUT_MS);
    });
  });

  describe('saveSessionData', () => {
    it('merges data and keeps session in active window by default', () => {
      generateSessionId('merge', 'capability-token');

      vi.advanceTimersByTime(10_000);
      saveSessionData({ myVote: 'B' });

      const stored = readStoredSession();
      const expectedNow = now.getTime() + 10_000;
      expect(getStringProperty(stored, 'myVote')).toBe('B');
      expect(getStringProperty(stored, 'phase')).toBe('voting');
      expect(getNumberProperty(stored, 'expiresAt')).toBe(expectedNow + SESSION_ACTIVE_TIMEOUT_MS);
    });

    it('transitions to verification phase and extends TTL when finalizeResult is canonical', () => {
      generateSessionId('final-phase', 'capability-token');

      saveSessionData({ finalizeResult: buildCanonicalFinalizeResult() });

      const stored = readStoredSession();
      expect(getStringProperty(stored, 'phase')).toBe('verifying');
      expect(getNumberProperty(stored, 'expiresAt')).toBe(now.getTime() + SESSION_VERIFICATION_TIMEOUT_MS);
    });

    it('keeps the active TTL when finalizeResult is unsupported', () => {
      generateSessionId('invalid-finalize-result', 'capability-token');

      saveSessionData({ finalizeResult: { tally: {} } as unknown as NonNullable<SessionData['finalizeResult']> });

      const stored = readStoredSession();
      expect(getStringProperty(stored, 'phase')).toBe('voting');
      expect(getNumberProperty(stored, 'expiresAt')).toBe(now.getTime() + SESSION_ACTIVE_TIMEOUT_MS);
      expect(stored.finalizeResult).toBeUndefined();
    });

    it('persists only the canonical current-contract finalization snapshot', () => {
      generateSessionId('canonical-cache', 'capability-token');

      saveSessionData({
        finalizeResult: {
          ...buildCanonicalFinalizeResult(),
          voteReceipt: {
            voteId: 'vote-1',
          },
        } as unknown as NonNullable<SessionData['finalizeResult']>,
      });

      const stored = readStoredSession();
      const finalizeResult = isRecord(stored.finalizeResult) ? stored.finalizeResult : null;
      expect(finalizeResult).not.toBeNull();
      expect(finalizeResult?.voteReceipt).toBeUndefined();
      expect(isRecord(finalizeResult?.journal)).toBe(true);
    });
  });

  describe('session isolation', () => {
    it('fails closed when localStorage session is replaced by another tab', () => {
      generateSessionId('session-a', 'capability-a');
      expect(isSessionReplaced()).toBe(false);

      localStorageMock.setItem(
        'starkBallotSession',
        JSON.stringify({
          sessionId: 'session-b',
          contractGeneration: resolveCurrentContractGeneration(),
          capabilityToken: 'capability-b',
          lastActivity: now.getTime(),
        }),
      );

      expect(getSessionData()).toBeNull();
      expect(isSessionReplaced()).toBe(true);
    });

    it('does not mutate replaced session data from stale tab', () => {
      generateSessionId('session-a', 'capability-a');
      localStorageMock.setItem(
        'starkBallotSession',
        JSON.stringify({
          sessionId: 'session-b',
          contractGeneration: resolveCurrentContractGeneration(),
          capabilityToken: 'capability-b',
          lastActivity: now.getTime(),
        }),
      );

      saveSessionData({ myVote: 'A' });
      updateLastActivity();

      const stored = readStoredSession();
      expect(getStringProperty(stored, 'sessionId')).toBe('session-b');
      expect(getStringProperty(stored, 'myVote')).toBeUndefined();
    });

    it('keeps expected session access bound after same-tab session replacement', () => {
      generateSessionId('session-a', 'capability-a');
      const expectedIdentity = captureSessionIdentity(getSessionData());

      generateSessionId('session-b', 'capability-b');

      expect(getSessionDataForIdentity(expectedIdentity)).toBeNull();
      expect(isSessionReplacedForIdentity(expectedIdentity)).toBe(true);
    });

    it('does not allow stale writes through expected-session helpers after same-tab replacement', () => {
      generateSessionId('session-a', 'capability-a');
      const expectedIdentity = captureSessionIdentity(getSessionData());

      generateSessionId('session-b', 'capability-b');

      saveSessionDataForIdentity(expectedIdentity, { myVote: 'A' });
      updateLastActivityForIdentity(expectedIdentity);

      const stored = readStoredSession();
      expect(getStringProperty(stored, 'sessionId')).toBe('session-b');
      expect(getStringProperty(stored, 'myVote')).toBeUndefined();
    });

    it('treats a missing localStorage session with a stale tab lock as replaced', () => {
      generateSessionId('session-a', 'capability-a');
      const expectedIdentity = captureSessionIdentity(getSessionData());

      localStorageMock.removeItem('starkBallotSession');

      expect(getSessionDataForIdentity(expectedIdentity)).toBeNull();
      expect(isSessionReplaced()).toBe(true);
      expect(isSessionReplacedForIdentity(expectedIdentity)).toBe(true);
    });
  });
});
