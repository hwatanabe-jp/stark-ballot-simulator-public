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
} from '../store';
import { resolveCurrentContractGeneration } from '@/lib/contract';
import { clearSession, generateSessionId } from '@/lib/session/client';
import { createTestJournal } from '@/lib/testing/test-helpers';

describe('Knowledge Store', () => {
  const currentGeneration = resolveCurrentContractGeneration();

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

    it('should return new items array', () => {
      const newItems = saveKnowledgeData({ sessionId: 'test', electionId: 'election' });

      expect(newItems).toHaveLength(2);
      expect(newItems.map((item) => item.key)).toContain('sessionId');
      expect(newItems.map((item) => item.key)).toContain('electionId');
    });

    it('should mark items as new', () => {
      const newItems = saveKnowledgeData({ sessionId: 'test' });

      expect(newItems[0].isNew).toBe(true);
    });

    it('should reset previous session knowledge when sessionId changes', () => {
      saveKnowledgeData({
        sessionId: 'session-a',
        'user.choice': 'A',
        electionId: 'election-a',
      });

      saveKnowledgeData({
        sessionId: 'session-b',
        electionId: 'election-b',
      });

      const data = getKnowledgeData();
      expect(data?.sessionId).toBe('session-b');
      expect(data?.electionId).toBe('election-b');
      expect(data?.['user.choice']).toBeUndefined();
    });

    it('should bind writes to the active session when sessionId is omitted', () => {
      generateSessionId('active-session', 'capability-token');

      saveKnowledgeData({ 'user.choice': 'B' });

      const data = getKnowledgeData();
      expect(data?.sessionId).toBe('active-session');
      expect(data?.['user.choice']).toBe('B');
    });

    it('should reject writes when expectedSessionId no longer matches the active session', () => {
      generateSessionId('session-a', 'capability-a');
      saveKnowledgeData({ sessionId: 'session-a', 'user.choice': 'A' });

      generateSessionId('session-b', 'capability-b');
      saveKnowledgeData({ 'user.choice': 'B' }, { expectedSessionId: 'session-a' });

      expect(getKnowledgeData()).toBeNull();
      expect(JSON.parse(localStorage.getItem('stark-ballot-knowledge') ?? '{}')).toEqual({
        sessionId: 'session-a',
        'user.choice': 'A',
      });
    });

    it('should reject writes when another tab replaces the active session and the local lock becomes stale', () => {
      generateSessionId('session-a', 'capability-a');
      saveKnowledgeData({ sessionId: 'session-a', electionId: 'election-a' });

      localStorage.setItem(
        'starkBallotSession',
        JSON.stringify({
          sessionId: 'session-b',
          capabilityToken: 'capability-b',
          contractGeneration: currentGeneration,
          lastActivity: Date.now(),
        }),
      );
      localStorage.setItem(
        'stark-ballot-knowledge',
        JSON.stringify({
          sessionId: 'session-b',
          electionId: 'election-b',
        }),
      );

      saveKnowledgeData({ 'user.choice': 'B' }, { expectedSessionId: 'session-a' });

      expect(getKnowledgeData()).toBeNull();
      expect(JSON.parse(localStorage.getItem('stark-ballot-knowledge') ?? '{}')).toEqual({
        sessionId: 'session-b',
        electionId: 'election-b',
      });
    });
  });

  describe('getKnowledgeData', () => {
    it('should return null when no data exists', () => {
      const data = getKnowledgeData();
      expect(data).toBeNull();
    });

    it('should return stored data', () => {
      saveKnowledgeData({ sessionId: 'test' });

      const data = getKnowledgeData();
      expect(data?.sessionId).toBe('test');
    });

    it('drops retired aliases, delivery keys, and proofMode on read', () => {
      localStorage.setItem(
        'stark-ballot-knowledge',
        JSON.stringify({
          sessionId: 'legacy-session',
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

      const data = getKnowledgeData();
      const persisted = JSON.parse(localStorage.getItem('stark-ballot-knowledge') ?? '{}') as Record<string, unknown>;

      expect(data).toEqual(
        expect.objectContaining({
          sessionId: 'legacy-session',
        }),
      );
      expect(data).not.toHaveProperty('missingIndices');
      expect(data).not.toHaveProperty('invalidIndices');
      expect(data).not.toHaveProperty('countedIndices');
      expect(data).not.toHaveProperty('excludedCount');
      expect(data).not.toHaveProperty('missingSlots');
      expect(data).not.toHaveProperty('invalidPresentedSlots');
      expect(data).not.toHaveProperty('validVotes');
      expect(data).not.toHaveProperty('excludedSlots');
      expect(data).not.toHaveProperty('user.merklePath');
      expect(data).not.toHaveProperty('s3BundleUrl');
      expect(data).not.toHaveProperty('s3BundleExpiresAt');
      expect(data).not.toHaveProperty('proofMode');
      expect(data).not.toHaveProperty('unknownKey');
      expect(persisted).toEqual(data);
    });

    it('clears stale knowledge when the shared storage schema version changes', () => {
      localStorage.setItem('starkBallotSessionSchemaVersion', 'stale-schema');
      localStorage.setItem(
        'stark-ballot-knowledge',
        JSON.stringify({
          sessionId: 'stale-session',
          electionId: 'stale-election',
        }),
      );

      expect(getKnowledgeData()).toBeNull();
      expect(localStorage.getItem('stark-ballot-knowledge')).toBeNull();
      expect(localStorage.getItem('starkBallotSessionSchemaVersion')).not.toBe('stale-schema');
    });

    it('hides knowledge for another session without deleting the shared snapshot', () => {
      generateSessionId('active-session', 'capability-token');
      localStorage.setItem(
        'stark-ballot-knowledge',
        JSON.stringify({
          sessionId: 'stale-session',
          electionId: 'stale-election',
        }),
      );

      expect(getKnowledgeData()).toBeNull();
      expect(JSON.parse(localStorage.getItem('stark-ballot-knowledge') ?? '{}')).toEqual({
        sessionId: 'stale-session',
        electionId: 'stale-election',
      });
    });

    it('clears session-less knowledge once an active session exists', () => {
      generateSessionId('active-session', 'capability-token');
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
      generateSessionId('session-a', 'capability-a');
      localStorage.setItem(
        'starkBallotSession',
        JSON.stringify({
          sessionId: 'session-b',
          capabilityToken: 'capability-b',
          contractGeneration: currentGeneration,
          lastActivity: Date.now(),
        }),
      );
      localStorage.setItem(
        'stark-ballot-knowledge',
        JSON.stringify({
          sessionId: 'session-b',
          electionId: 'election-b',
        }),
      );

      expect(getKnowledgeValue('electionId')).toBeUndefined();
      expect(JSON.parse(localStorage.getItem('stark-ballot-knowledge') ?? '{}')).toEqual({
        sessionId: 'session-b',
        electionId: 'election-b',
      });
    });
  });

  describe('clearKnowledge', () => {
    it('should remove all knowledge data', () => {
      saveKnowledgeData({
        sessionId: 'test',
        electionId: 'election',
        'user.choice': 'A',
      });

      clearKnowledge();

      expect(getKnowledgeData()).toBeNull();
    });
  });

  describe('clearKnowledgeForSession', () => {
    it('clears a snapshot that belongs to the targeted session', () => {
      saveKnowledgeData({
        sessionId: 'test-session',
        electionId: 'test-election',
      });

      clearKnowledgeForSession('test-session');

      expect(localStorage.getItem('stark-ballot-knowledge')).toBeNull();
    });

    it('does not clear a snapshot that belongs to another session', () => {
      localStorage.setItem(
        'stark-ballot-knowledge',
        JSON.stringify({
          sessionId: 'other-session',
          electionId: 'other-election',
        }),
      );

      clearKnowledgeForSession('expected-session');

      expect(JSON.parse(localStorage.getItem('stark-ballot-knowledge') ?? '{}')).toEqual({
        sessionId: 'other-session',
        electionId: 'other-election',
      });
    });
  });

  describe('clearBotKnowledge', () => {
    it('should clear only bot-scoped keys', () => {
      saveKnowledgeData({
        sessionId: 'test-session',
        'user.choice': 'A',
        'bot.id': 42,
        'bot.choice': 'B',
        'bot.commitment': '0xbot',
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

    it('should filter out undefined/null values', () => {
      localStorage.setItem('stark-ballot-knowledge', JSON.stringify({ sessionId: 'test', nullField: null }));

      const items = getKnowledgeItems();

      expect(items).toHaveLength(1);
      expect(items[0].key).toBe('sessionId');
    });
  });

  describe('mergeKnowledgeFromApi', () => {
    it('should omit specified keys when merging', () => {
      mergeKnowledgeFromApi(
        'verify',
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
      const journal = {
        ...createTestJournal({
          totalExpected: 64,
          validVotes: 61,
          missingSlots: 1,
          invalidPresentedSlots: 2,
        }),
        rejectedRecords: 2,
        invalidPresentedSlots: 0,
      };

      mergeKnowledgeFromApi('verify', {
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
