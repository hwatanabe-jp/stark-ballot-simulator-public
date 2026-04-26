/**
 * Tests for /api/zkvm-input-hash endpoint
 * t-wada's approach: RED Phase - Write failing tests first
 */

import { GET } from './route';
import { DEFAULT_POC_IMAGE_ID } from '@/app/api/finalize/routeConstants';
import { NextRequest } from 'next/server';
import { MockSessionStore } from '@/lib/store/mockSessionStore';
import { resetGlobalStore } from '@/lib/store/storeInstance';
import type { ZkVMInputHashResponse, ZkVMInputHashError } from '@/lib/types/api/zkvm-input-hash';
import { readJsonRecord } from '@/lib/testing/response-helpers';
import { getStringProperty } from '@/lib/utils/guards';
import { computeInputCommitment } from '@/lib/zkvm/types';
import { SESSION_CAPABILITY_HEADER } from '@/lib/session/capability';
import { createTestSessionCapabilityToken, setTestSessionCapabilitySecret } from '@/lib/testing/sessionCapability';
import { createDebugLogToken } from '@/lib/security/debugLogToken';
import { DEBUG_LOG_HEADER_NAME } from '@/server/http/debugLog';
import { createTestJournal } from '@/lib/testing/test-helpers';
import { createTestPublicInputArtifact } from '@/lib/testing/public-input-artifact';
import { buildCloseStatement, buildElectionManifest } from '@/lib/verification/public-audit-artifacts';
import { buildDefaultElectionConfig } from '@/lib/zkvm/election-config';
import { resolveCurrentContractGeneration } from '@/lib/contract';

const DEFAULT_COUNTS = {
  A: 13,
  B: 13,
  C: 13,
  D: 13,
  E: 12,
} as const;

const VOTE_CHOICES = ['A', 'B', 'C', 'D', 'E'] as const;

const createFinalizationResult = (counts: Record<'A' | 'B' | 'C' | 'D' | 'E', number>) => {
  const totalVotes = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const journal = createTestJournal({
    totalExpected: totalVotes,
    validVotes: totalVotes,
    missingIndices: 0,
    invalidIndices: 0,
  });
  const electionManifest = buildElectionManifest(journal.electionId, buildDefaultElectionConfig());
  journal.electionConfigHash = electionManifest.electionConfigHash;
  const closeStatement = buildCloseStatement({
    logId: '0x' + '2'.repeat(64),
    treeSize: journal.treeSize,
    timestamp: 123,
    bulletinRoot: journal.bulletinRoot,
  });
  journal.sthDigest = closeStatement.sthDigest;

  return {
    tally: {
      counts,
      totalVotes,
      tamperedCount: 0,
    },
    receipt: {
      seal: 'mock-seal',
      journal: 'mock-journal',
    },
    imageId: DEFAULT_POC_IMAGE_ID,
    journal,
    publicInputArtifact: createTestPublicInputArtifact({
      executionId: 'exec-zkvm-input-hash',
      typedAuthority: {
        electionId: journal.electionId,
        electionConfigHash: journal.electionConfigHash,
        methodVersion: journal.methodVersion,
        bulletinRoot: journal.bulletinRoot,
        treeSize: journal.treeSize,
        totalExpected: journal.totalExpected,
        votesCount: journal.validVotes,
        logId: '0x' + '2'.repeat(64),
        timestamp: 123,
        recomputedInputCommitment: journal.inputCommitment,
      },
    }),
    electionManifest,
    closeStatement,
    verificationExecutionId: 'exec-zkvm-input-hash',
  };
};

function createAuthorizedRequest(url: URL, options: { debug?: boolean } = {}): NextRequest {
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) {
    return new NextRequest(url);
  }
  const headers: Record<string, string> = {
    [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
  };

  if (options.debug) {
    const debugSecret = process.env.DEBUG_LOG_SECRET;
    if (!debugSecret) {
      throw new Error('DEBUG_LOG_SECRET must be set for debug request tests');
    }
    const expiresAt = Math.floor(Date.now() / 1000) + 60;
    headers[DEBUG_LOG_HEADER_NAME] = createDebugLogToken({ expiresAt, level: 'debug' }, debugSecret);
  }

  return new NextRequest(url, {
    headers,
  });
}

describe('/api/zkvm-input-hash', () => {
  let mockStore: MockSessionStore;
  const originalEnv = process.env.USE_MOCK_STORE;

  beforeEach(() => {
    // Use mock store for tests
    process.env.USE_MOCK_STORE = 'true';
    process.env.EXPECTED_IMAGE_ID = DEFAULT_POC_IMAGE_ID;
    process.env.DEBUG_LOG_SECRET = 'debug-log-secret-for-tests-0123456789abcdef';
    setTestSessionCapabilitySecret();
    resetGlobalStore();
    mockStore = new MockSessionStore();
    // Replace the global store instance
    global.__globalStoreInstance = mockStore;
  });

  afterEach(() => {
    // Restore original environment
    process.env.USE_MOCK_STORE = originalEnv;
    delete process.env.EXPECTED_IMAGE_ID;
    delete process.env.DEBUG_LOG_SECRET;
    resetGlobalStore();
  });

  describe('GET request', () => {
    it('should return input commitment hash for a finalized session', async () => {
      // Create a finalized session with votes
      const session = await mockStore.createSession();

      // Add a user vote
      await mockStore.addVote(session.sessionId, {
        commit: '0x' + 'aa'.repeat(32),
        vote: 'A',
        rand: '0x' + 'bb'.repeat(32),
        path: [],
      });

      // Add bot votes
      const botVotes = [];
      for (let i = 1; i < 64; i++) {
        botVotes.push({
          commit: '0x' + `${i.toString(16).padStart(2, '0')}`.repeat(32),
          vote: VOTE_CHOICES[i % VOTE_CHOICES.length],
          rand: '0x' + `${(i + 100).toString(16).padStart(2, '0')}`.repeat(32),
          path: [],
        });
      }
      await mockStore.addBotVotes(session.sessionId, botVotes);

      // Finalize the session
      await mockStore.finalizeSession(
        session.sessionId,
        createFinalizationResult({ ...DEFAULT_COUNTS }),
        resolveCurrentContractGeneration(),
      );

      // Create request
      const url = new URL(`http://localhost/api/zkvm-input-hash?sessionId=${session.sessionId}`);
      const request = createAuthorizedRequest(url, { debug: true });

      // Call the endpoint
      const response = await GET(request);
      const data = (await response.json()) as ZkVMInputHashResponse;

      // Check response
      expect(response.status).toBe(200);
      expect(data.inputCommitment).toBeDefined();
      expect(data.inputCommitment).toMatch(/^(0x)?[0-9a-f]{64}$/); // 64 hex chars with optional 0x prefix
      expect(data.data).toBeUndefined(); // No data by default
    });

    it('should include zkVM input data when includeData=true', async () => {
      // Create a finalized session
      const session = await mockStore.createSession();
      await mockStore.addVote(session.sessionId, {
        commit: '0x' + 'aa'.repeat(32),
        vote: 'A',
        rand: '0x' + 'bb'.repeat(32),
        path: [],
      });

      const botVotes = [];
      for (let i = 1; i < 64; i++) {
        botVotes.push({
          commit: '0x' + `${i.toString(16).padStart(2, '0')}`.repeat(32),
          vote: VOTE_CHOICES[i % VOTE_CHOICES.length],
          rand: '0x' + `${(i + 100).toString(16).padStart(2, '0')}`.repeat(32),
          path: [],
        });
      }
      await mockStore.addBotVotes(session.sessionId, botVotes);

      await mockStore.finalizeSession(
        session.sessionId,
        createFinalizationResult({ ...DEFAULT_COUNTS }),
        resolveCurrentContractGeneration(),
      );

      // Create request with includeData=true
      const url = new URL(`http://localhost/api/zkvm-input-hash?sessionId=${session.sessionId}&includeData=true`);
      const request = createAuthorizedRequest(url, { debug: true });

      // Call the endpoint
      const response = await GET(request);
      const data = (await response.json()) as ZkVMInputHashResponse;

      // Check response
      expect(response.status).toBe(200);
      expect(data.inputCommitment).toBeDefined();
      expect(data.data).toBeDefined();
      expect(data.data?.zkVMInput).toBeDefined();
      expect(data.data?.votesCount).toBe(64);
      expect(data.data?.treeSize).toBe(64);
      expect(data.data?.bulletinRoot).toBeDefined();
      expect(data.data?.electionId).toBeDefined();
      expect(data.data?.timestamp).toBeDefined();

      // Verify that the inputCommitment matches the computed value
      if (!data.data) {
        throw new Error('Expected zkVM input data to be present');
      }
      const expectedHash = computeInputCommitment(data.data.zkVMInput);
      expect(data.inputCommitment).toBe(expectedHash);
    });

    it('should return 404 for non-existent session', async () => {
      const url = new URL('http://localhost/api/zkvm-input-hash?sessionId=non-existent');
      const request = createAuthorizedRequest(url);

      const response = await GET(request);
      const data = (await response.json()) as ZkVMInputHashError;

      expect(response.status).toBe(404);
      expect(data.error).toBeDefined();
      expect(data.code).toBe('SESSION_NOT_FOUND');
    });

    it('should return 403 when includeData=true without debug authorization', async () => {
      const session = await mockStore.createSession();
      await mockStore.addVote(session.sessionId, {
        commit: '0x' + 'aa'.repeat(32),
        vote: 'A',
        rand: '0x' + 'bb'.repeat(32),
        path: [],
      });

      const botVotes = [];
      for (let i = 1; i < 64; i++) {
        botVotes.push({
          commit: '0x' + `${i.toString(16).padStart(2, '0')}`.repeat(32),
          vote: VOTE_CHOICES[i % VOTE_CHOICES.length],
          rand: '0x' + `${(i + 100).toString(16).padStart(2, '0')}`.repeat(32),
          path: [],
        });
      }
      await mockStore.addBotVotes(session.sessionId, botVotes);
      await mockStore.finalizeSession(
        session.sessionId,
        createFinalizationResult({ ...DEFAULT_COUNTS }),
        resolveCurrentContractGeneration(),
      );

      const url = new URL(`http://localhost/api/zkvm-input-hash?sessionId=${session.sessionId}&includeData=true`);
      const response = await GET(createAuthorizedRequest(url));
      const data = (await response.json()) as ZkVMInputHashError;

      expect(response.status).toBe(403);
      expect(data.code).toBe('INCLUDE_DATA_FORBIDDEN');
    });

    it('should return 400 for non-finalized session', async () => {
      // Create a session but don't finalize it
      const session = await mockStore.createSession();
      await mockStore.addVote(session.sessionId, {
        commit: '0x' + 'aa'.repeat(32),
        vote: 'A',
        rand: '0x' + 'bb'.repeat(32),
        path: [],
      });

      const url = new URL(`http://localhost/api/zkvm-input-hash?sessionId=${session.sessionId}`);
      const request = createAuthorizedRequest(url);

      const response = await GET(request);
      const data = (await response.json()) as ZkVMInputHashError;

      expect(response.status).toBe(400);
      expect(data.error).toBeDefined();
      expect(data.code).toBe('SESSION_NOT_FINALIZED');
    });

    it('fails closed when finalized zkVM input state is unsupported', async () => {
      const session = await mockStore.createSession();
      await mockStore.addVote(session.sessionId, {
        commit: '0x' + 'aa'.repeat(32),
        vote: 'A',
        rand: '0x' + 'bb'.repeat(32),
        path: [],
      });
      await mockStore.finalizeSession(
        session.sessionId,
        createFinalizationResult({ ...DEFAULT_COUNTS }),
        resolveCurrentContractGeneration(),
      );

      session.finalizationArtifactState = 'unsupported_current_artifact';

      const url = new URL(`http://localhost/api/zkvm-input-hash?sessionId=${session.sessionId}`);
      const response = await GET(createAuthorizedRequest(url));
      const payload = await readJsonRecord(response, 'zkvm input hash');

      expect(response.status).toBe(500);
      expect(getStringProperty(payload, 'error')).toBe('UNSUPPORTED_CURRENT_ARTIFACT');
      expect(getStringProperty(payload, 'artifactState')).toBe('unsupported_current_artifact');
    });

    it('should return 400 when sessionId is missing', async () => {
      const url = new URL('http://localhost/api/zkvm-input-hash');
      const request = createAuthorizedRequest(url);

      const response = await GET(request);
      const data = (await response.json()) as ZkVMInputHashError;

      expect(response.status).toBe(400);
      expect(data.error).toBeDefined();
      expect(data.code).toBe('INVALID_REQUEST');
    });

    it('should return 401 when capability token is missing', async () => {
      const session = await mockStore.createSession();
      const url = new URL(`http://localhost/api/zkvm-input-hash?sessionId=${session.sessionId}`);
      const request = new NextRequest(url);

      const response = await GET(request);
      const data = (await response.json()) as { error?: string };

      expect(response.status).toBe(401);
      expect(data.error).toBe('SESSION_CAPABILITY_REQUIRED');
    });

    it('should compute consistent hash for the same session data', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));

      // Create two sessions with FIXED electionId and logId for consistent hashing
      const fixedElectionId = '550e8400-e29b-41d4-a716-446655440000';
      const fixedLogId = '0x' + '00'.repeat(32);
      const fixedTimestamp = Date.now();

      const session1 = await mockStore.createSession();
      const session2 = await mockStore.createSession();

      // Override electionId, logId, and bulletinRootHistory timestamps to ensure consistency
      session1.electionId = fixedElectionId;
      session1.logId = fixedLogId;
      session1.bulletinRootHistory = [{ root: '0x' + '0'.repeat(64), timestamp: fixedTimestamp, treeSize: 0 }];

      session2.electionId = fixedElectionId;
      session2.logId = fixedLogId;
      session2.bulletinRootHistory = [{ root: '0x' + '0'.repeat(64), timestamp: fixedTimestamp, treeSize: 0 }];

      // Add identical votes to both sessions
      const voteData = {
        commit: '0x' + 'aa'.repeat(32),
        vote: 'A' as const,
        rand: '0x' + 'bb'.repeat(32),
        path: [],
      };

      await mockStore.addVote(session1.sessionId, voteData);
      await mockStore.addVote(session2.sessionId, voteData);

      // Add identical bot votes
      const botVotes = [];
      for (let i = 1; i < 64; i++) {
        botVotes.push({
          commit: '0x' + `${i.toString(16).padStart(2, '0')}`.repeat(32),
          vote: VOTE_CHOICES[i % VOTE_CHOICES.length],
          rand: '0x' + `${(i + 100).toString(16).padStart(2, '0')}`.repeat(32),
          path: [],
        });
      }
      await mockStore.addBotVotes(session1.sessionId, botVotes);
      await mockStore.addBotVotes(session2.sessionId, botVotes);

      // Update bulletinRootHistory with fixed timestamp after votes
      // Use a fixed root hash instead of getting it from bulletin (which may not have getRoot method in tests)
      const fixedBulletinRoot = '0x' + '1'.repeat(64);
      const finalRootHistory = [{ root: fixedBulletinRoot, timestamp: fixedTimestamp, treeSize: 64 }];
      session1.bulletinRootHistory = finalRootHistory;
      session2.bulletinRootHistory = finalRootHistory;

      await mockStore.finalizeSession(
        session1.sessionId,
        createFinalizationResult({ ...DEFAULT_COUNTS }),
        resolveCurrentContractGeneration(),
      );
      await mockStore.finalizeSession(
        session2.sessionId,
        createFinalizationResult({ ...DEFAULT_COUNTS }),
        resolveCurrentContractGeneration(),
      );

      // Get hashes for both sessions
      const url1 = new URL(`http://localhost/api/zkvm-input-hash?sessionId=${session1.sessionId}`);
      const response1 = await GET(createAuthorizedRequest(url1));
      const data1 = (await response1.json()) as ZkVMInputHashResponse;

      const url2 = new URL(`http://localhost/api/zkvm-input-hash?sessionId=${session2.sessionId}`);
      const response2 = await GET(createAuthorizedRequest(url2));
      const data2 = (await response2.json()) as ZkVMInputHashResponse;

      // Hashes should be identical for identical data
      expect(data1.inputCommitment).toBe(data2.inputCommitment);

      vi.useRealTimers();
    });

    it('should handle boolean parameter parsing correctly', async () => {
      const session = await mockStore.createSession();
      await mockStore.addVote(session.sessionId, {
        commit: '0x' + 'aa'.repeat(32),
        vote: 'A',
        rand: '0x' + 'bb'.repeat(32),
        path: [],
      });

      const botVotes = [];
      for (let i = 1; i < 64; i++) {
        botVotes.push({
          commit: '0x' + `${i.toString(16).padStart(2, '0')}`.repeat(32),
          vote: VOTE_CHOICES[i % VOTE_CHOICES.length],
          rand: '0x' + `${(i + 100).toString(16).padStart(2, '0')}`.repeat(32),
          path: [],
        });
      }
      await mockStore.addBotVotes(session.sessionId, botVotes);

      await mockStore.finalizeSession(
        session.sessionId,
        createFinalizationResult({ ...DEFAULT_COUNTS }),
        resolveCurrentContractGeneration(),
      );

      // Test various boolean values
      const testCases = [
        { value: 'true', shouldInclude: true },
        { value: 'false', shouldInclude: false },
        { value: '1', shouldInclude: true },
        { value: '0', shouldInclude: false },
        { value: 'yes', shouldInclude: true },
        { value: 'no', shouldInclude: false },
        { value: '', shouldInclude: false },
        { value: 'invalid', shouldInclude: false },
      ];

      for (const testCase of testCases) {
        const url = new URL(
          `http://localhost/api/zkvm-input-hash?sessionId=${session.sessionId}&includeData=${testCase.value}`,
        );
        const request = createAuthorizedRequest(url, { debug: testCase.shouldInclude });
        const response = await GET(request);
        const data = (await response.json()) as ZkVMInputHashResponse;

        expect(response.status).toBe(200);
        if (testCase.shouldInclude) {
          expect(data.data).toBeDefined();
        } else {
          expect(data.data).toBeUndefined();
        }
      }
    });
  });
});
