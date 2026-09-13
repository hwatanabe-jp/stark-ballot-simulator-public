import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import {
  saveKnowledgeData,
  getKnowledgeData,
  getKnowledgeValue,
  clearKnowledge,
  clearKnowledgeForSession,
  clearBotKnowledge,
  subscribeToKnowledge,
  getKnowledgeItems,
  mergeKnowledgeFromApi,
} from './store';
import { clearSession, initializeSession } from '@stark-ballot/web/session/client';
import type { ServerIssuedSessionIdentity } from '@stark-ballot/web/session/types';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

const ELECTION_ID = '123e4567-e89b-42d3-a456-426614174000';
const ELECTION_CONFIG_HASH = `0x${'a'.repeat(64)}`;
const LOG_ID = `0x${'b'.repeat(64)}`;

function sessionIdentity(sessionId: string, capabilityToken: string): ServerIssuedSessionIdentity {
  return {
    sessionId,
    capabilityToken,
    electionId: ELECTION_ID,
    electionConfigHash: ELECTION_CONFIG_HASH,
    logId: LOG_ID,
  };
}

function initializeTestSession(sessionId: string, capabilityToken: string): void {
  initializeSession(sessionIdentity(sessionId, capabilityToken));
}

function storedVotingSession(sessionId: string, capabilityToken: string): Record<string, unknown> {
  const now = Date.now();
  return {
    ...sessionIdentity(sessionId, capabilityToken),
    phase: 'voting',
    lastActivity: now,
    expiresAt: now + 30 * 60 * 1000,
  };
}

describe('Knowledge Store', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
    sessionStorage.clear();
    clearSession();
    // Clear any existing knowledge data
    clearKnowledge();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    clearSession();
  });

  describe('saveKnowledgeData', () => {
    it('should save data to localStorage', () => {
      saveKnowledgeData({ sessionId: 'test-session' });

      const stored = localStorage.getItem('stark-ballot-knowledge');
      expect(stored).toBeTruthy();

      const parsed = JSON.parse(stored ?? '{}') as { sessionId?: string };
      expect(parsed.sessionId).toBe('test-session');
    });

    it('should merge with existing data', () => {
      saveKnowledgeData({ sessionId: 'test-session' });
      saveKnowledgeData({ electionId: 'test-election' });

      const data = getKnowledgeData();
      expect(data?.sessionId).toBe('test-session');
      expect(data?.electionId).toBe('test-election');
    });

    it('should overwrite existing values on same key', () => {
      saveKnowledgeData({ sessionId: 'old-session' });
      saveKnowledgeData({ sessionId: 'new-session' });

      const data = getKnowledgeData();
      expect(data?.sessionId).toBe('new-session');
    });

    it('should ignore undefined values', () => {
      saveKnowledgeData({ sessionId: 'test-session' });
      saveKnowledgeData({ sessionId: undefined, electionId: 'test-election' });

      const data = getKnowledgeData();
      expect(data?.sessionId).toBe('test-session');
      expect(data?.electionId).toBe('test-election');
    });

    it.each([
      [
        'fractional tally counts',
        {
          tally: {
            counts: { A: 0.5, B: 0, C: 0, D: 0, E: 0 },
            totalVotes: 0.5,
          },
        },
      ],
      ['a negative count', { missingSlots: -1 }],
      [
        'an unknown verification step',
        {
          verificationSteps: [{ id: 'future_stage', status: 'success', inputs: [] }],
        },
      ],
      [
        'a malformed inclusion proof',
        {
          'user.merklePath': {
            leafIndex: 0,
            treeSize: 1,
            merklePath: ['not-hex'],
            bulletinRootAtCast: `0x${'1'.repeat(64)}`,
          },
        },
      ],
    ] satisfies Array<[string, Record<string, unknown>]>)(
      'rejects an API patch with %s before writing',
      (_label, patch) => {
        saveKnowledgeData({ sessionId: 'test-session', electionId: 'test-election' });
        const listener = vi.fn();
        const unsubscribe = subscribeToKnowledge(listener);
        const before = localStorage.getItem('stark-ballot-knowledge');

        const newItems = mergeKnowledgeFromApi(patch);

        expect(newItems).toEqual([]);
        expect(localStorage.getItem('stark-ballot-knowledge')).toBe(before);
        expect(getKnowledgeData()).toEqual({ sessionId: 'test-session', electionId: 'test-election' });
        expect(listener).not.toHaveBeenCalled();
        unsubscribe();
      },
    );

    it('stores only the admitted knowledge summary from a full verifier report', () => {
      saveKnowledgeData({ sessionId: 'test-session', electionId: 'test-election' });

      const newItems = mergeKnowledgeFromApi({
        verificationReport: {
          status: 'success',
          verifier_version: 'test-verifier',
          verified_at: '2026-08-02T00:00:00.000Z',
          duration_ms: 5000,
          expected_image_id: `0x${'1'.repeat(64)}`,
          receipt_image_id: `0x${'1'.repeat(64)}`,
          dev_mode_receipt: false,
          errors: ['diagnostic'],
        },
      });

      expect(newItems).toHaveLength(1);
      expect(getKnowledgeData()).toEqual({
        sessionId: 'test-session',
        electionId: 'test-election',
        'verification.reportSummary': {
          status: 'success',
          duration_ms: 5000,
          errors: ['diagnostic'],
        },
      });
    });

    it('stores the exact current receipt publication with its optional timestamp', () => {
      saveKnowledgeData({ sessionId: 'test-session', electionId: 'test-election' });
      const receiptPublication = {
        receiptHash: `0x${'c'.repeat(64)}`,
        boardIndex: 7,
        timestamp: 1_700_000_000_000,
      };

      const newItems = mergeKnowledgeFromApi({
        receiptPublication,
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
        },
      });

      expect(newItems.map((item) => item.key)).toEqual(
        expect.arrayContaining(['receiptPublication', 'tally.counts', 'tally.totalVotes']),
      );
      expect(getKnowledgeData()).toMatchObject({ receiptPublication });
    });

    it('should return new items array', () => {
      const newItems = saveKnowledgeData({ sessionId: 'test', electionId: 'election' });

      expect(newItems).toHaveLength(2);
      expect(newItems.map((item) => item.key)).toContain('sessionId');
      expect(newItems.map((item) => item.key)).toContain('electionId');
    });

    it('should mark items as new', () => {
      const newItems = saveKnowledgeData({ sessionId: 'test' });

      expect(strictDefined(newItems[0]).isNew).toBe(true);
    });

    it('should reset previous session knowledge when sessionId changes', () => {
      saveKnowledgeData({
        ...omitUndefinedProperties({ sessionId: 'session-a' }),
        'user.choice': 'A',
        electionId: 'election-a',
      });

      saveKnowledgeData({
        ...omitUndefinedProperties({ sessionId: 'session-b' }),
        electionId: 'election-b',
      });

      const data = getKnowledgeData();
      expect(data?.sessionId).toBe('session-b');
      expect(data?.electionId).toBe('election-b');
      expect(data?.['user.choice']).toBeUndefined();
    });

    it('should bind writes to the active session when sessionId is omitted', () => {
      initializeTestSession('active-session', 'capability-token');

      saveKnowledgeData({ 'user.choice': 'B' });

      const data = getKnowledgeData();
      expect(data?.sessionId).toBe('active-session');
      expect(data?.['user.choice']).toBe('B');
    });

    it('should reject writes when expectedSessionId no longer matches the active session', () => {
      initializeTestSession('session-a', 'capability-a');
      saveKnowledgeData({ sessionId: 'session-a', 'user.choice': 'A' });

      initializeTestSession('session-b', 'capability-b');
      saveKnowledgeData({ 'user.choice': 'B' }, { expectedSessionId: 'session-a' });

      expect(getKnowledgeData()).toBeNull();
      expect(JSON.parse(localStorage.getItem('stark-ballot-knowledge') ?? '{}')).toEqual({
        ...omitUndefinedProperties({ sessionId: 'session-a' }),
        'user.choice': 'A',
      });
    });

    it('should reject writes when another tab replaces the active session and the local lock becomes stale', () => {
      initializeTestSession('session-a', 'capability-a');
      saveKnowledgeData({ sessionId: 'session-a', electionId: 'election-a' });

      localStorage.setItem('starkBallotSession', JSON.stringify(storedVotingSession('session-b', 'capability-b')));
      localStorage.setItem(
        'stark-ballot-knowledge',
        JSON.stringify({
          ...omitUndefinedProperties({ sessionId: 'session-b' }),
          electionId: 'election-b',
        }),
      );

      saveKnowledgeData({ 'user.choice': 'B' }, { expectedSessionId: 'session-a' });

      expect(getKnowledgeData()).toBeNull();
      expect(JSON.parse(localStorage.getItem('stark-ballot-knowledge') ?? '{}')).toEqual({
        ...omitUndefinedProperties({ sessionId: 'session-b' }),
        electionId: 'election-b',
      });
    });
  });

  describe('getKnowledgeData', () => {
    it('should return null when no data exists', () => {
      const data = getKnowledgeData();
      expect(data).toBeNull();
    });

    it('clears malformed stored knowledge', () => {
      localStorage.setItem('stark-ballot-knowledge', '{not-json');

      expect(getKnowledgeData()).toBeNull();
      expect(localStorage.getItem('stark-ballot-knowledge')).toBeNull();
    });

    it('should return stored data', () => {
      saveKnowledgeData({ sessionId: 'test' });

      const data = getKnowledgeData();
      expect(data?.sessionId).toBe('test');
    });

    it('rejects a retired or unknown stored shape without repairing it', () => {
      localStorage.setItem(
        'stark-ballot-knowledge',
        JSON.stringify({
          ...omitUndefinedProperties({ sessionId: 'legacy-session' }),
          missingIndices: 1,
          invalidIndices: 2,
          countedIndices: 61,
          excludedCount: 3,
          s3BundleUrl: 'https://example.com/bundle.zip',
          s3BundleExpiresAt: '2026-01-01T00:00:00.000Z',
          proofMode: 'rfc6962',
          unknownKey: 'legacy-value',
          'user.merklePath': {
            proofMode: 'rfc6962',
            leafIndex: 1,
            treeSize: 4,
            merklePath: ['0x' + '1'.repeat(64)],
            bulletinRootAtCast: '0x' + '2'.repeat(64),
          },
        }),
      );

      expect(getKnowledgeData()).toBeNull();
      expect(localStorage.getItem('stark-ballot-knowledge')).toBeNull();
    });

    it.each([
      ['negative leaf index', { leafIndex: -1 }],
      ['fractional leaf index', { leafIndex: 0.5 }],
      ['empty tree', { treeSize: 0 }],
      ['leaf outside the tree', { leafIndex: 1 }],
      ['non-hex Merkle path', { merklePath: ['not-hex'] }],
      ['non-hex bulletin root', { bulletinRootAtCast: 'not-hex' }],
    ])('rejects a current-shape inclusion proof with %s', (_label, proofPatch) => {
      localStorage.setItem(
        'stark-ballot-knowledge',
        JSON.stringify({
          sessionId: 'test-session',
          'user.merklePath': {
            leafIndex: 0,
            treeSize: 1,
            merklePath: [],
            bulletinRootAtCast: `0x${'1'.repeat(64)}`,
            ...proofPatch,
          },
        }),
      );

      expect(getKnowledgeData()).toBeNull();
      expect(localStorage.getItem('stark-ballot-knowledge')).toBeNull();
    });

    it('does not consult the retired storage schema marker', () => {
      localStorage.setItem('starkBallotSessionSchemaVersion', 'stale-schema');
      localStorage.setItem(
        'stark-ballot-knowledge',
        JSON.stringify({
          ...omitUndefinedProperties({ sessionId: 'stale-session' }),
          electionId: 'stale-election',
        }),
      );

      expect(getKnowledgeData()).toEqual({
        ...omitUndefinedProperties({ sessionId: 'stale-session' }),
        electionId: 'stale-election',
      });
      expect(localStorage.getItem('starkBallotSessionSchemaVersion')).toBe('stale-schema');
    });

    it('hides knowledge for another session without deleting the shared snapshot', () => {
      initializeTestSession('active-session', 'capability-token');
      localStorage.setItem(
        'stark-ballot-knowledge',
        JSON.stringify({
          ...omitUndefinedProperties({ sessionId: 'stale-session' }),
          electionId: 'stale-election',
        }),
      );

      expect(getKnowledgeData()).toBeNull();
      expect(JSON.parse(localStorage.getItem('stark-ballot-knowledge') ?? '{}')).toEqual({
        ...omitUndefinedProperties({ sessionId: 'stale-session' }),
        electionId: 'stale-election',
      });
    });

    it('does not repair or delete an invalid replacement snapshot from a stale tab', () => {
      initializeTestSession('session-a', 'capability-a');
      localStorage.setItem('starkBallotSession', JSON.stringify(storedVotingSession('session-b', 'capability-b')));
      const replacementSnapshot = JSON.stringify({
        ...omitUndefinedProperties({ sessionId: 'session-b' }),
        electionId: 'election-b',
        unknownKey: 'must-remain-owned-by-session-b',
      });
      localStorage.setItem('stark-ballot-knowledge', replacementSnapshot);

      expect(getKnowledgeData()).toBeNull();
      expect(localStorage.getItem('stark-ballot-knowledge')).toBe(replacementSnapshot);
    });

    it('clears session-less knowledge once an active session exists', () => {
      initializeTestSession('active-session', 'capability-token');
      localStorage.setItem(
        'stark-ballot-knowledge',
        JSON.stringify({
          electionId: 'floating-knowledge',
        }),
      );

      expect(getKnowledgeData()).toBeNull();
      expect(localStorage.getItem('stark-ballot-knowledge')).toBeNull();
    });
  });

  describe('getKnowledgeValue', () => {
    it('should return undefined when no data exists', () => {
      const value = getKnowledgeValue('sessionId');
      expect(value).toBeUndefined();
    });

    it('should return specific value', () => {
      saveKnowledgeData({ sessionId: 'test', electionId: 'election' });

      expect(getKnowledgeValue('sessionId')).toBe('test');
      expect(getKnowledgeValue('electionId')).toBe('election');
    });

    it('returns undefined in a stale tab without deleting the current snapshot', () => {
      initializeTestSession('session-a', 'capability-a');
      localStorage.setItem('starkBallotSession', JSON.stringify(storedVotingSession('session-b', 'capability-b')));
      localStorage.setItem(
        'stark-ballot-knowledge',
        JSON.stringify({
          ...omitUndefinedProperties({ sessionId: 'session-b' }),
          electionId: 'election-b',
        }),
      );

      expect(getKnowledgeValue('electionId')).toBeUndefined();
      expect(JSON.parse(localStorage.getItem('stark-ballot-knowledge') ?? '{}')).toEqual({
        ...omitUndefinedProperties({ sessionId: 'session-b' }),
        electionId: 'election-b',
      });
    });
  });

  describe('clearKnowledge', () => {
    it('notifies mounted consumers after clearing the snapshot', () => {
      saveKnowledgeData({ sessionId: 'test-session', electionId: 'test-election' });
      const observations: ReturnType<typeof getKnowledgeItems>[] = [];
      const unsubscribe = subscribeToKnowledge(() => observations.push(getKnowledgeItems()));
      try {
        clearKnowledge();
        expect(observations).toEqual([[]]);
      } finally {
        unsubscribe();
      }
    });
    it('should remove all knowledge data', () => {
      saveKnowledgeData({
        ...omitUndefinedProperties({ sessionId: 'test' }),
        electionId: 'election',
        'user.choice': 'A',
      });

      clearKnowledge();

      expect(getKnowledgeData()).toBeNull();
    });
  });

  describe('clearKnowledgeForSession', () => {
    it('notifies consumers only when the targeted snapshot is cleared', () => {
      saveKnowledgeData({ sessionId: 'test-session', electionId: 'test-election' });
      const listener = vi.fn();
      const unsubscribe = subscribeToKnowledge(listener);
      try {
        clearKnowledgeForSession('different-session');
        expect(listener).not.toHaveBeenCalled();
        clearKnowledgeForSession('test-session');
        expect(listener).toHaveBeenCalledWith([], 'session');
        expect(getKnowledgeItems()).toEqual([]);
      } finally {
        unsubscribe();
      }
    });
    it('clears a snapshot that belongs to the targeted session', () => {
      saveKnowledgeData({
        ...omitUndefinedProperties({ sessionId: 'test-session' }),
        electionId: 'test-election',
      });

      clearKnowledgeForSession('test-session');

      expect(localStorage.getItem('stark-ballot-knowledge')).toBeNull();
    });

    it('does not clear a snapshot that belongs to another session', () => {
      localStorage.setItem(
        'stark-ballot-knowledge',
        JSON.stringify({
          ...omitUndefinedProperties({ sessionId: 'other-session' }),
          electionId: 'other-election',
        }),
      );

      clearKnowledgeForSession('expected-session');

      expect(JSON.parse(localStorage.getItem('stark-ballot-knowledge') ?? '{}')).toEqual({
        ...omitUndefinedProperties({ sessionId: 'other-session' }),
        electionId: 'other-election',
      });
    });
  });

  describe('clearBotKnowledge', () => {
    it('notifies consumers after deletion but leaves an unchanged snapshot quiet', () => {
      saveKnowledgeData({ sessionId: 'test-session', 'bot.id': 42, 'user.choice': 'A' });
      const listener = vi.fn(() => getKnowledgeData());
      const unsubscribe = subscribeToKnowledge(listener);
      try {
        clearBotKnowledge();
        expect(listener).toHaveBeenCalledExactlyOnceWith([], 'verify');
        expect(listener.mock.results[0]?.value).toEqual({ sessionId: 'test-session', 'user.choice': 'A' });
        clearBotKnowledge();
        expect(listener).toHaveBeenCalledTimes(1);
      } finally {
        unsubscribe();
      }
    });

    it('should clear only bot-scoped keys', () => {
      const commitment = `0x${'a'.repeat(64)}`;
      saveKnowledgeData({
        ...omitUndefinedProperties({ sessionId: 'test-session' }),
        'user.choice': 'A',
        'bot.id': 42,
        'bot.choice': 'B',
        'bot.commitment': commitment,
      });

      expect(getKnowledgeData()).toMatchObject({
        'bot.id': 42,
        'bot.choice': 'B',
        'bot.commitment': commitment,
      });

      clearBotKnowledge();

      const data = getKnowledgeData();
      expect(data?.sessionId).toBe('test-session');
      expect(data?.['user.choice']).toBe('A');
      expect(data?.['bot.id']).toBeUndefined();
      expect(data?.['bot.choice']).toBeUndefined();
      expect(data?.['bot.commitment']).toBeUndefined();
    });
  });

  describe('subscribeToKnowledge', () => {
    it('should call listener when new data is added', () => {
      const listener = vi.fn();
      const unsubscribe = subscribeToKnowledge(listener);

      saveKnowledgeData({ sessionId: 'test' });

      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
    });

    it('should not call listener after unsubscribe', () => {
      const listener = vi.fn();
      const unsubscribe = subscribeToKnowledge(listener);

      unsubscribe();

      saveKnowledgeData({ sessionId: 'test' });

      expect(listener).not.toHaveBeenCalled();
    });

    it('should not call listener when value unchanged', () => {
      saveKnowledgeData({ sessionId: 'test' });

      const listener = vi.fn();
      const unsubscribe = subscribeToKnowledge(listener);

      // Save same value again
      saveKnowledgeData({ sessionId: 'test' });

      expect(listener).not.toHaveBeenCalled();

      unsubscribe();
    });
  });

  describe('getKnowledgeItems', () => {
    it.each(['corrupt', 'expired'] as const)(
      'returns no values on the first read that rejects a %s session',
      (state) => {
        initializeTestSession('test-session', 'test-capability');
        saveKnowledgeData({ electionId: ELECTION_ID, 'user.choice': 'A' });
        const session = storedVotingSession('test-session', 'test-capability');
        localStorage.setItem(
          'starkBallotSession',
          JSON.stringify(
            state === 'corrupt' ? { ...session, phase: 'invalid' } : { ...session, lastActivity: 0, expiresAt: 1 },
          ),
        );

        expect(getKnowledgeItems()).toEqual([]);
        expect(localStorage.getItem('stark-ballot-knowledge')).toBeNull();
      },
    );

    it('should return empty array when no data', () => {
      const items = getKnowledgeItems();
      expect(items).toEqual([]);
    });

    it('should return items with key/value pairs', () => {
      saveKnowledgeData({ sessionId: 'test', electionId: 'election' });

      const items = getKnowledgeItems();

      expect(items).toHaveLength(2);
      expect(items.find((i) => i.key === 'sessionId')?.value).toBe('test');
      expect(items.find((i) => i.key === 'electionId')?.value).toBe('election');
    });

    it('fails closed on a stored null or unknown key', () => {
      localStorage.setItem('stark-ballot-knowledge', JSON.stringify({ sessionId: 'test', nullField: null }));

      const items = getKnowledgeItems();

      expect(items).toEqual([]);
      expect(localStorage.getItem('stark-ballot-knowledge')).toBeNull();
    });
  });

  describe('mergeKnowledgeFromApi', () => {
    it('should omit specified keys when merging', () => {
      mergeKnowledgeFromApi(
        {
          voteReceipt: {
            voteId: 'vote-123',
            commitment: '0xabc',
            bulletinIndex: 1,
            bulletinRootAtCast: '0xroot',
            timestamp: 123,
          },
        },
        { omitKeys: ['user.voteReceipt'] },
      );

      const data = getKnowledgeData();
      expect(data?.['user.voteReceipt']).toBeUndefined();
    });

    it('prefers canonical journal-derived proof fields over stale top-level copies', () => {
      const journal = createTestJournal({
        totalExpected: 62,
        validVotes: 61,
        missingSlots: 1,
        invalidPresentedSlots: 0,
      });

      mergeKnowledgeFromApi({
        tally: {
          counts: { A: 61, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 61,
          tamperedCount: 3,
        },
        imageId: '0x' + '9'.repeat(64),
        bulletinRoot: '0x' + '1'.repeat(64),
        treeSize: 999,
        totalExpected: 999,
        missingSlots: 99,
        invalidPresentedSlots: 98,
        validVotes: 0,
        rejectedRecords: 77,
        sthDigest: '0x' + '2'.repeat(64),
        seenBitmapRoot: '0x' + '3'.repeat(64),
        includedBitmapRoot: '0x' + '4'.repeat(64),
        inputCommitment: '0x' + '5'.repeat(64),
        journal,
      });

      const data = getKnowledgeData();
      expect(data?.bulletinRoot).toBe(journal.bulletinRoot);
      expect(data?.treeSize).toBe(journal.treeSize);
      expect(data?.totalExpected).toBe(journal.totalExpected);
      expect(data?.missingSlots).toBe(1);
      expect(data?.invalidPresentedSlots).toBe(0);
      expect(data?.validVotes).toBe(journal.validVotes);
      expect(data?.rejectedRecords).toBe(journal.rejectedRecords);
      expect(data?.sthDigest).toBe(journal.sthDigest);
      expect(data?.seenBitmapRoot).toBe(journal.seenBitmapRoot);
      expect(data?.includedBitmapRoot).toBe(journal.includedBitmapRoot);
      expect(data?.inputCommitment).toBe(journal.inputCommitment);
      expect(data?.imageId).toBe('0x' + '9'.repeat(64));
    });
  });

  describe('phase routing', () => {
    it('treats seenBitmapRoot updates as result-phase knowledge', () => {
      const listener = vi.fn();
      const unsubscribe = subscribeToKnowledge(listener);

      saveKnowledgeData({ seenBitmapRoot: '0x' + 'a'.repeat(64) });

      expect(listener).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            key: 'seenBitmapRoot',
            value: '0x' + 'a'.repeat(64),
          }),
        ],
        'result',
      );

      unsubscribe();
    });

    it('treats rejectedRecords updates as result-phase knowledge', () => {
      const listener = vi.fn();
      const unsubscribe = subscribeToKnowledge(listener);

      saveKnowledgeData({ rejectedRecords: 2 });

      expect(listener).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            key: 'rejectedRecords',
            value: 2,
          }),
        ],
        'result',
      );

      unsubscribe();
    });
  });
});
