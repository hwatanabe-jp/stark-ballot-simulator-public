import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureSessionIdentity,
  clearSession,
  getSessionData,
  getSessionDataForIdentity,
  initializeSession,
  isSessionReplaced,
  isSessionReplacedForIdentity,
  saveSessionData,
  saveSessionDataForIdentity,
  SESSION_ACTIVE_TIMEOUT_MS,
  SESSION_VERIFICATION_TIMEOUT_MS,
  updateLastActivity,
  updateLastActivityForIdentity,
} from './client';
import type { ServerIssuedSessionIdentity, SessionData } from './types';
import { resolveCanonicalFinalizationPayload } from '@stark-ballot/web/finalize/client-finalization-result';
import { clearClientFinalizedProjection } from '@stark-ballot/web/finalize/client-finalization-boundary';
import { getNumberProperty, getStringProperty, isRecord } from '@stark-ballot/validation/unknown-value-guards';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';

const ELECTION_ID = '123e4567-e89b-42d3-a456-426614174000';
const ELECTION_CONFIG_HASH = `0x${'a'.repeat(64)}`;
const LOG_ID = `0x${'b'.repeat(64)}`;
const COMMITMENT = `0x${'c'.repeat(64)}`;
const RANDOM_VALUE = `0x${'d'.repeat(64)}`;

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

function identity(
  sessionId: string,
  capabilityToken: string,
  overrides: Partial<ServerIssuedSessionIdentity> = {},
): ServerIssuedSessionIdentity {
  return {
    sessionId,
    capabilityToken,
    electionId: ELECTION_ID,
    electionConfigHash: ELECTION_CONFIG_HASH,
    logId: LOG_ID,
    ...overrides,
  };
}

function initializeTestSession(sessionId: string, capabilityToken: string): string {
  return initializeSession(identity(sessionId, capabilityToken));
}

function storedVotingSession(
  sessionId: string,
  capabilityToken: string,
  now: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...identity(sessionId, capabilityToken),
    phase: 'voting',
    lastActivity: now,
    expiresAt: now + SESSION_ACTIVE_TIMEOUT_MS,
    ...overrides,
  };
}

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
    missingSlots: 0,
    invalidPresentedSlots: 0,
    seenIndicesCount: 1,
  });
  const result = resolveCanonicalFinalizationPayload({
    finalizationId: 'finalization-1',
    tally: {
      counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
      totalVotes: 1,
      tamperedCount: 0,
    },
    imageId: `0x${'e'.repeat(64)}`,
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initializeSession', () => {
    it('stores one complete server-issued identity with active defaults', () => {
      const setItem = vi.spyOn(localStorageMock, 'setItem');

      const sessionId = initializeTestSession('server-session-id', 'capability-token');

      expect(sessionId).toBe('server-session-id');
      expect(setItem.mock.calls.filter(([key]) => key === 'starkBallotSession')).toHaveLength(1);
      expect(readStoredSession()).toEqual({
        ...identity('server-session-id', 'capability-token'),
        phase: 'voting',
        lastActivity: now.getTime(),
        expiresAt: now.getTime() + SESSION_ACTIVE_TIMEOUT_MS,
      });
      expect(window.sessionStorage.getItem('starkBallotSessionLock')).toBe(
        JSON.stringify({
          sessionId: 'server-session-id',
          capabilityToken: 'capability-token',
        }),
      );
    });

    it('accepts a safe server-provided session ID', () => {
      initializeTestSession('session-with-safe-id', 'capability-token');

      expect(getStringProperty(readStoredSession(), 'sessionId')).toBe('session-with-safe-id');
    });

    it('throws when the capability token is empty', () => {
      expect(() => initializeSession(identity('server-session-id', ''))).toThrow(
        'Invalid server-issued session identity',
      );
      expect(localStorageMock.getItem('starkBallotSession')).toBeNull();
    });

    it('rejects incomplete or malformed server identity before writing browser state', () => {
      expect(() =>
        initializeSession(identity('server-session-id', 'capability-token', { electionConfigHash: 'not-a-hash' })),
      ).toThrow('Invalid server-issued session identity');
      expect(localStorageMock.getItem('starkBallotSession')).toBeNull();
      expect(window.sessionStorage.getItem('starkBallotSessionLock')).toBeNull();
    });
  });

  describe('clearSession', () => {
    it('removes session data', () => {
      initializeTestSession('clear-me', 'capability-token');

      clearSession();

      expect(localStorageMock.getItem('starkBallotSession')).toBeNull();
    });
  });

  describe('updateLastActivity', () => {
    it('updates lastActivity and extends expiry', () => {
      initializeTestSession('heartbeat', 'capability-token');

      vi.advanceTimersByTime(15_000);
      updateLastActivity();

      const stored = readStoredSession();
      const expectedNow = now.getTime() + 15_000;
      expect(getNumberProperty(stored, 'lastActivity')).toBe(expectedNow);
      expect(getNumberProperty(stored, 'expiresAt')).toBe(expectedNow + SESSION_ACTIVE_TIMEOUT_MS);
    });

    it('preserves complete private opening evidence while updating activity', () => {
      initializeTestSession('preserve', 'capability-token');
      saveSessionData({ myVote: 'A', myCommit: COMMITMENT, myRand: RANDOM_VALUE });

      vi.advanceTimersByTime(5_000);
      updateLastActivity();

      const stored = readStoredSession();
      expect(getStringProperty(stored, 'myVote')).toBe('A');
      expect(getStringProperty(stored, 'myCommit')).toBe(COMMITMENT);
      expect(getStringProperty(stored, 'myRand')).toBe(RANDOM_VALUE);
    });
  });

  describe('getSessionData', () => {
    it('returns the exact active session without read-time normalization', () => {
      initializeTestSession('current-session', 'capability-token');

      expect(getSessionData()).toEqual(readStoredSession());
    });

    it('returns null and clears an expired exact session', () => {
      localStorageMock.setItem(
        'starkBallotSession',
        JSON.stringify(
          storedVotingSession('expired', 'capability-token', now.getTime(), {
            expiresAt: now.getTime() - 1,
          }),
        ),
      );

      expect(getSessionData()).toBeNull();
      expect(localStorageMock.getItem('starkBallotSession')).toBeNull();
    });

    it('clears records missing required identity and their knowledge data', () => {
      const record = storedVotingSession('incomplete-session', 'capability-token', now.getTime());
      delete record['logId'];
      localStorageMock.setItem('starkBallotSession', JSON.stringify(record));
      localStorageMock.setItem('stark-ballot-knowledge', JSON.stringify({ sessionId: 'incomplete-session' }));

      expect(getSessionData()).toBeNull();
      expect(localStorageMock.getItem('starkBallotSession')).toBeNull();
      expect(localStorageMock.getItem('stark-ballot-knowledge')).toBeNull();
    });

    it('does not read retired generation fields as aliases', () => {
      localStorageMock.setItem(
        'starkBallotSession',
        JSON.stringify(
          storedVotingSession('retired-contract-field', 'capability-token', now.getTime(), {
            contractGeneration: 'retired-contract',
          }),
        ),
      );

      expect(getSessionData()).toBeNull();
      expect(localStorageMock.getItem('starkBallotSession')).toBeNull();
    });

    it('clears the tab lock when a nonconforming record is rejected', () => {
      initializeTestSession('invalid-session', 'capability-token');
      const expectedIdentity = captureSessionIdentity(getSessionData());
      const invalid = storedVotingSession('invalid-session', 'capability-token', now.getTime());
      delete invalid['electionId'];
      localStorageMock.setItem('starkBallotSession', JSON.stringify(invalid));

      expect(getSessionData()).toBeNull();
      expect(window.sessionStorage.getItem('starkBallotSessionLock')).toBeNull();
      expect(isSessionReplaced()).toBe(false);
      expect(isSessionReplacedForIdentity(expectedIdentity)).toBe(false);
    });

    it('rejects unsupported cached finalization snapshots as a whole', () => {
      initializeTestSession('session-with-stale-result', 'capability-token');
      localStorageMock.setItem(
        'starkBallotSession',
        JSON.stringify(
          storedVotingSession('session-with-stale-result', 'capability-token', now.getTime(), {
            phase: 'verifying',
            expiresAt: now.getTime() + SESSION_VERIFICATION_TIMEOUT_MS,
            verificationRequestedAt: now.getTime(),
            finalizeResult: {
              tally: {
                counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
                totalVotes: 1,
                tamperedCount: 0,
              },
              imageId: `0x${'1'.repeat(64)}`,
            },
          }),
        ),
      );

      expect(getSessionData()).toBeNull();
      expect(localStorageMock.getItem('starkBallotSession')).toBeNull();
      expect(window.sessionStorage.getItem('starkBallotSessionLock')).toBeNull();
    });

    it('rejects journal-only finalization snapshots instead of rebuilding browser tally state', () => {
      localStorageMock.setItem(
        'starkBallotSession',
        JSON.stringify(
          storedVotingSession('session-with-journal-only-result', 'capability-token', now.getTime(), {
            phase: 'verifying',
            expiresAt: now.getTime() + SESSION_VERIFICATION_TIMEOUT_MS,
            finalizeResult: {
              imageId: `0x${'e'.repeat(64)}`,
              journal: createTestJournal({
                totalExpected: 1,
                validVotes: 1,
                missingSlots: 0,
                invalidPresentedSlots: 0,
                seenIndicesCount: 1,
              }),
            },
          }),
        ),
      );

      expect(getSessionData()).toBeNull();
      expect(localStorageMock.getItem('starkBallotSession')).toBeNull();
    });
  });

  describe('saveSessionData', () => {
    it('merges complete opening data and keeps the session in its active window', () => {
      initializeTestSession('merge', 'capability-token');

      vi.advanceTimersByTime(10_000);
      saveSessionData({ myVote: 'B', myCommit: COMMITMENT, myRand: RANDOM_VALUE });

      const stored = readStoredSession();
      const expectedNow = now.getTime() + 10_000;
      expect(getStringProperty(stored, 'myVote')).toBe('B');
      expect(getStringProperty(stored, 'phase')).toBe('voting');
      expect(getNumberProperty(stored, 'expiresAt')).toBe(expectedNow + SESSION_ACTIVE_TIMEOUT_MS);
    });

    it('transitions to verification phase and extends TTL for an exact finalization snapshot', () => {
      initializeTestSession('final-phase', 'capability-token');

      saveSessionData({ finalizeResult: buildCanonicalFinalizeResult() });

      const stored = readStoredSession();
      expect(getStringProperty(stored, 'phase')).toBe('verifying');
      expect(getNumberProperty(stored, 'expiresAt')).toBe(now.getTime() + SESSION_VERIFICATION_TIMEOUT_MS);
    });

    it('rejects an unsupported finalization snapshot without rewriting the active record', () => {
      initializeTestSession('invalid-finalize-result', 'capability-token');
      const before = readStoredSession();

      expect(() =>
        saveSessionData({ finalizeResult: { tally: {} } as unknown as NonNullable<SessionData['finalizeResult']> }),
      ).toThrow('Invalid browser session state');

      expect(readStoredSession()).toEqual(before);
    });

    it('rejects unknown nested finalization fields instead of sanitizing them', () => {
      initializeTestSession('exact-cache', 'capability-token');
      const before = readStoredSession();

      expect(() =>
        saveSessionData({
          finalizeResult: {
            ...buildCanonicalFinalizeResult(),
            voteReceipt: { voteId: 'vote-1' },
          } as unknown as NonNullable<SessionData['finalizeResult']>,
        }),
      ).toThrow('Invalid browser session state');

      expect(readStoredSession()).toEqual(before);
    });

    it('clears verification continuation markers when explicitly patched to undefined', () => {
      initializeTestSession('clear-verification-marker', 'capability-token');
      saveSessionData({
        finalizeResult: buildCanonicalFinalizeResult(),
        verificationRequestedAt: now.getTime(),
      });

      saveSessionData({ verificationRequestedAt: undefined });

      const session = getSessionData();
      expect(session?.finalizeResult).toBeDefined();
      expect(session?.verificationRequestedAt).toBeUndefined();
      expect(readStoredSession()['verificationRequestedAt']).toBeUndefined();
    });

    it('clears finalization and verification continuation state together', () => {
      initializeTestSession('clear-finalized-projection', 'capability-token');
      saveSessionData({
        finalizeResult: buildCanonicalFinalizeResult(),
        verificationRequestedAt: now.getTime(),
      });

      clearClientFinalizedProjection();

      const session = getSessionData();
      expect(session?.phase).toBe('voting');
      expect(session?.finalizeResult).toBeUndefined();
      expect(session?.verificationRequestedAt).toBeUndefined();
    });
  });

  describe('session isolation', () => {
    it('does not read or write through expected-session helpers without an expected identity', () => {
      initializeTestSession('session-a', 'capability-a');

      expect(getSessionDataForIdentity(null)).toBeNull();
      saveSessionDataForIdentity(null, {
        myVote: 'A',
        myCommit: COMMITMENT,
        myRand: RANDOM_VALUE,
      });

      expect(readStoredSession()['myVote']).toBeUndefined();
    });

    it('fails closed when localStorage session is replaced by another tab', () => {
      initializeTestSession('session-a', 'capability-a');
      expect(isSessionReplaced()).toBe(false);

      localStorageMock.setItem(
        'starkBallotSession',
        JSON.stringify(storedVotingSession('session-b', 'capability-b', now.getTime())),
      );

      expect(getSessionData()).toBeNull();
      expect(isSessionReplaced()).toBe(true);
    });

    it('does not mutate replaced session data from a stale tab', () => {
      initializeTestSession('session-a', 'capability-a');
      localStorageMock.setItem(
        'starkBallotSession',
        JSON.stringify(storedVotingSession('session-b', 'capability-b', now.getTime())),
      );

      saveSessionData({ myVote: 'A', myCommit: COMMITMENT, myRand: RANDOM_VALUE });
      updateLastActivity();

      const stored = readStoredSession();
      expect(getStringProperty(stored, 'sessionId')).toBe('session-b');
      expect(getStringProperty(stored, 'myVote')).toBeUndefined();
    });

    it('keeps expected session access bound after same-tab session replacement', () => {
      initializeTestSession('session-a', 'capability-a');
      const expectedIdentity = captureSessionIdentity(getSessionData());

      initializeTestSession('session-b', 'capability-b');

      expect(getSessionDataForIdentity(expectedIdentity)).toBeNull();
      expect(isSessionReplacedForIdentity(expectedIdentity)).toBe(true);
    });

    it('does not allow stale writes through expected-session helpers after same-tab replacement', () => {
      initializeTestSession('session-a', 'capability-a');
      const expectedIdentity = captureSessionIdentity(getSessionData());

      initializeTestSession('session-b', 'capability-b');
      saveSessionDataForIdentity(expectedIdentity, {
        myVote: 'A',
        myCommit: COMMITMENT,
        myRand: RANDOM_VALUE,
      });
      updateLastActivityForIdentity(expectedIdentity);

      const stored = readStoredSession();
      expect(getStringProperty(stored, 'sessionId')).toBe('session-b');
      expect(getStringProperty(stored, 'myVote')).toBeUndefined();
    });

    it('treats a missing localStorage session with a stale tab lock as replaced', () => {
      initializeTestSession('session-a', 'capability-a');
      const expectedIdentity = captureSessionIdentity(getSessionData());

      localStorageMock.removeItem('starkBallotSession');

      expect(getSessionDataForIdentity(expectedIdentity)).toBeNull();
      expect(isSessionReplaced()).toBe(true);
      expect(isSessionReplacedForIdentity(expectedIdentity)).toBe(true);
    });
  });
});
