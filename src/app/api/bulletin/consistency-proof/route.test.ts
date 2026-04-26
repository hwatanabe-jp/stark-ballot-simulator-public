import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from './route';
import { NextRequest } from 'next/server';
import { MockSessionStore } from '@/lib/store/mockSessionStore';
import * as storeInstance from '@/lib/store/storeInstance';
import type { VoteData } from '@/types/server';
import type { VoteChoice } from '@/shared/constants';
import { createTestCommitment, DEFAULT_TEST_ELECTION_ID } from '@/lib/testing/commitment-test-helpers';
import { readJsonRecord } from '@/lib/testing/response-helpers';
import { getNumberProperty, getStringArrayProperty, getStringProperty } from '@/lib/utils/guards';
import { SESSION_CAPABILITY_HEADER } from '@/lib/session/capability';
import { createTestSessionCapabilityToken, setTestSessionCapabilitySecret } from '@/lib/testing/sessionCapability';

describe('GET /api/bulletin/consistency-proof', () => {
  let mockStore: MockSessionStore;
  let sessionId: string;

  beforeEach(async () => {
    setTestSessionCapabilitySecret();
    mockStore = new MockSessionStore();
    vi.spyOn(storeInstance, 'getGlobalStore').mockReturnValue(mockStore);

    // Create a session with some votes
    const session = await mockStore.createSession();
    sessionId = session.sessionId;

    // Ensure session has electionId
    if (session.electionId === undefined) {
      session.electionId = DEFAULT_TEST_ELECTION_ID;
    }

    // Add some votes to build a Merkle tree with unique commitments
    for (let i = 0; i < 10; i++) {
      const { commitment, random } = createTestCommitment(i % 5); // Cycle through choices

      const voteData: VoteData = {
        vote: 'ABCDE'[i % 5] as VoteChoice,
        rand: random,
        commit: commitment,
        path: [],
      };
      await mockStore.addVote(sessionId, voteData);
    }
  });

  describe('正常系', () => {
    it('should return consistency proof for valid parameters', async () => {
      const request = new NextRequest(`http://localhost:3000/api/bulletin/consistency-proof?oldSize=5&newSize=10`, {
        headers: {
          'X-Session-ID': sessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
        },
      });

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'consistency proof');

      expect(response.status).toBe(200);
      expect(getNumberProperty(payload, 'oldSize')).toBe(5);
      expect(getNumberProperty(payload, 'newSize')).toBe(10);
      expect(getStringProperty(payload, 'rootAtOldSize')).toBeDefined();
      expect(getStringProperty(payload, 'rootAtNewSize')).toBeDefined();
      const proofNodes = getStringArrayProperty(payload, 'proofNodes');
      expect(proofNodes).toBeDefined();
      expect(Array.isArray(proofNodes)).toBe(true);
      expect(getNumberProperty(payload, 'timestamp')).toBeDefined();
    });

    it('should handle edge case: oldSize=0', async () => {
      const request = new NextRequest(`http://localhost:3000/api/bulletin/consistency-proof?oldSize=0&newSize=5`, {
        headers: {
          'X-Session-ID': sessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
        },
      });

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'consistency proof');

      expect(response.status).toBe(200);
      expect(getNumberProperty(payload, 'oldSize')).toBe(0);
      expect(getNumberProperty(payload, 'newSize')).toBe(5);
      // Empty tree root should be consistent
      expect(getStringProperty(payload, 'rootAtOldSize')).toBeDefined();
    });

    it('should handle equal sizes', async () => {
      const request = new NextRequest(`http://localhost:3000/api/bulletin/consistency-proof?oldSize=5&newSize=5`, {
        headers: {
          'X-Session-ID': sessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
        },
      });

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'consistency proof');

      expect(response.status).toBe(200);
      expect(getNumberProperty(payload, 'oldSize')).toBe(5);
      expect(getNumberProperty(payload, 'newSize')).toBe(5);
      // Same root for same size
      expect(getStringProperty(payload, 'rootAtOldSize')).toBe(getStringProperty(payload, 'rootAtNewSize'));
      // Empty proof for same size
      expect(getStringArrayProperty(payload, 'proofNodes')).toHaveLength(0);
    });
  });

  describe('エラー系', () => {
    it('should return 400 if session ID is missing', async () => {
      const request = new NextRequest(`http://localhost:3000/api/bulletin/consistency-proof?oldSize=5&newSize=10`);

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'consistency proof');

      expect(response.status).toBe(400);
      expect(getStringProperty(payload, 'error')).toBeDefined();
    });

    it('should return 400 if capability token is missing', async () => {
      const request = new NextRequest(`http://localhost:3000/api/bulletin/consistency-proof?oldSize=5&newSize=10`, {
        headers: {
          'X-Session-ID': sessionId,
        },
      });

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'consistency proof');

      expect(response.status).toBe(401);
      expect(getStringProperty(payload, 'error')).toBe('SESSION_CAPABILITY_REQUIRED');
    });

    it('should return 404 if session not found', async () => {
      const request = new NextRequest(`http://localhost:3000/api/bulletin/consistency-proof?oldSize=5&newSize=10`, {
        headers: {
          'X-Session-ID': 'non-existent-session',
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('non-existent-session'),
        },
      });

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'consistency proof');

      expect(response.status).toBe(404);
      expect(getStringProperty(payload, 'error')).toBeDefined();
    });

    it('fails closed when finalized consistency-proof state is unsupported', async () => {
      const session = await mockStore.getSession(sessionId);
      if (!session) {
        throw new Error('Expected session to exist');
      }

      session.finalized = true;
      session.finalizationArtifactState = 'unsupported_current_artifact';

      const request = new NextRequest(`http://localhost:3000/api/bulletin/consistency-proof?oldSize=5&newSize=10`, {
        headers: {
          'X-Session-ID': sessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
        },
      });

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'consistency proof');

      expect(response.status).toBe(500);
      expect(getStringProperty(payload, 'error')).toBe('UNSUPPORTED_CURRENT_ARTIFACT');
      expect(getStringProperty(payload, 'artifactState')).toBe('unsupported_current_artifact');
    });

    it('should return 400 if oldSize is missing', async () => {
      const request = new NextRequest(`http://localhost:3000/api/bulletin/consistency-proof?newSize=10`, {
        headers: {
          'X-Session-ID': sessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
        },
      });

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'consistency proof');

      expect(response.status).toBe(400);
      expect(getStringProperty(payload, 'error')).toContain('oldSize');
    });

    it('should return 400 if newSize is missing', async () => {
      const request = new NextRequest(`http://localhost:3000/api/bulletin/consistency-proof?oldSize=5`, {
        headers: {
          'X-Session-ID': sessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
        },
      });

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'consistency proof');

      expect(response.status).toBe(400);
      expect(getStringProperty(payload, 'error')).toContain('newSize');
    });

    it('should return 400 if oldSize > newSize', async () => {
      const request = new NextRequest(`http://localhost:3000/api/bulletin/consistency-proof?oldSize=10&newSize=5`, {
        headers: {
          'X-Session-ID': sessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
        },
      });

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'consistency proof');

      expect(response.status).toBe(400);
      expect(getStringProperty(payload, 'error')).toContain('oldSize cannot be greater than newSize');
    });

    it('should return 400 if oldSize is negative', async () => {
      const request = new NextRequest(`http://localhost:3000/api/bulletin/consistency-proof?oldSize=-1&newSize=10`, {
        headers: {
          'X-Session-ID': sessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
        },
      });

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'consistency proof');

      expect(response.status).toBe(400);
      expect(getStringProperty(payload, 'error')).toContain('must be non-negative');
    });

    it('should return 400 if newSize exceeds current tree size', async () => {
      const request = new NextRequest(`http://localhost:3000/api/bulletin/consistency-proof?oldSize=5&newSize=100`, {
        headers: {
          'X-Session-ID': sessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
        },
      });

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'consistency proof');

      expect(response.status).toBe(400);
      expect(getStringProperty(payload, 'error')).toContain('exceeds current tree size');
    });
  });

  describe('境界値テスト', () => {
    it('should handle oldSize=0, newSize=1', async () => {
      const request = new NextRequest(`http://localhost:3000/api/bulletin/consistency-proof?oldSize=0&newSize=1`, {
        headers: {
          'X-Session-ID': sessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
        },
      });

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'consistency proof');

      expect(response.status).toBe(200);
      expect(getNumberProperty(payload, 'oldSize')).toBe(0);
      expect(getNumberProperty(payload, 'newSize')).toBe(1);
    });

    it('should handle maximum tree size', async () => {
      const request = new NextRequest(`http://localhost:3000/api/bulletin/consistency-proof?oldSize=9&newSize=10`, {
        headers: {
          'X-Session-ID': sessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
        },
      });

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'consistency proof');

      expect(response.status).toBe(200);
      expect(getNumberProperty(payload, 'oldSize')).toBe(9);
      expect(getNumberProperty(payload, 'newSize')).toBe(10);
      expect(getStringArrayProperty(payload, 'proofNodes')?.length ?? 0).toBeGreaterThan(0);
    });
  });
});
