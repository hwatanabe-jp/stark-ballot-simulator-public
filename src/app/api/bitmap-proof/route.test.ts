/**
 * Tests for /api/bitmap-proof endpoint
 * Following final_design.md §2.6.1 specifications
 *
 * TDD RED phase: Writing tests before implementation
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { getGlobalStore } from '@/lib/store/storeInstance';
import type { StoredBitmapData } from '@/lib/types/api/bitmap-proof';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import { readJsonRecord } from '@/lib/testing/response-helpers';
import { getArrayProperty, getStringProperty, isRecord } from '@/lib/utils/guards';
import type { VoteStore } from '@/types/voteStore';
import type { SessionData } from '@/types/server';
import { SESSION_CAPABILITY_HEADER } from '@/lib/session/capability';
import { createTestSessionCapabilityToken, setTestSessionCapabilitySecret } from '@/lib/testing/sessionCapability';
import { resolveCurrentContractGeneration } from '@/lib/contract';

// Mock the store
vi.mock('@/lib/store/storeInstance', () => ({
  getGlobalStore: vi.fn(),
}));

describe('/api/bitmap-proof', () => {
  let mockStore: VoteStore;
  let getBitmapDataMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['getBitmapData']>>>;
  let getSessionMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['getSession']>>>;
  const sessionId = 'test-session-123';

  const createAuthedRequest = (url: URL, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest => {
    const headers = new Headers(init?.headers);
    headers.set('X-Session-ID', sessionId);
    headers.set(SESSION_CAPABILITY_HEADER, createTestSessionCapabilityToken(sessionId));
    return new NextRequest(url, { ...init, headers });
  };

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    setTestSessionCapabilitySecret();

    // Create mock store
    getBitmapDataMock = vi.fn<NonNullable<VoteStore['getBitmapData']>>();
    const now = Date.now();
    const session: SessionData = {
      sessionId,
      contractGeneration: resolveCurrentContractGeneration(),
      votes: new Map(),
      botCount: 0,
      finalized: false,
      createdAt: now,
      lastActivity: now,
    };
    getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(session);
    mockStore = createMockVoteStore({
      getBitmapData: getBitmapDataMock,
      getSession: getSessionMock,
    });

    // Return mock store
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);
  });

  describe('GET requests', () => {
    it('should return bitmap proof for valid index', async () => {
      // Setup test data
      const testBitmap = Array.from({ length: 512 }, () => false);
      testBitmap[42] = true;
      testBitmap[100] = true;

      const storedData: StoredBitmapData = {
        sessionId: 'test-session-123',
        includedBitmap: testBitmap,
        includedBitmapRoot: '0xabcdef123456789',
        treeSize: 512,
        finalizedAt: Date.now(),
      };

      getBitmapDataMock.mockResolvedValue(storedData);

      // Create request
      const url = new URL('http://localhost:3000/api/bitmap-proof?i=42');
      const request = createAuthedRequest(url);

      // Execute
      const response = await GET(request);
      const payload = await readJsonRecord(response, 'bitmap proof');
      const leafChunk = getStringProperty(payload, 'leafChunk');
      const auditPath = getArrayProperty(payload, 'auditPath') ?? [];

      // Verify response
      expect(response.status).toBe(200);
      expect(leafChunk).toBeDefined();
      expect(leafChunk).toHaveLength(64); // 32 bytes in hex
      expect(Array.isArray(auditPath)).toBe(true);

      // Verify audit path structure
      if (auditPath.length > 0) {
        const firstNode = auditPath[0];
        expect(isRecord(firstNode)).toBe(true);
        if (isRecord(firstNode)) {
          expect(getStringProperty(firstNode, 'hash')).toBeDefined();
          const position = getStringProperty(firstNode, 'position');
          expect(position).toBeDefined();
          expect(['left', 'right']).toContain(position);
        }
      }
    });

    it('should return seen bitmap proof when kind=seen is requested', async () => {
      const includedBitmap = Array.from({ length: 32 }, () => false);
      const seenBitmap = Array.from({ length: 32 }, () => false);
      seenBitmap[7] = true;

      const storedData: StoredBitmapData = {
        sessionId: 'test-session-123',
        includedBitmap,
        includedBitmapRoot: '0xabcdef123456789',
        seenBitmap,
        seenBitmapRoot: '0x123456789abcdef',
        treeSize: 32,
        finalizedAt: Date.now(),
      };

      getBitmapDataMock.mockResolvedValue(storedData);

      const url = new URL('http://localhost:3000/api/bitmap-proof?i=7&kind=seen');
      const request = createAuthedRequest(url);

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'bitmap proof');

      expect(response.status).toBe(200);
      expect(getStringProperty(payload, 'leafChunk')).toBeDefined();
    });

    it('should return error for missing index parameter', async () => {
      const url = new URL('http://localhost:3000/api/bitmap-proof');
      const request = createAuthedRequest(url);

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'bitmap proof');

      expect(response.status).toBe(400);
      expect(getStringProperty(payload, 'error')).toBeDefined();
      expect(getStringProperty(payload, 'code')).toBe('INVALID_INDEX');
    });

    it('should reject request without capability token', async () => {
      const url = new URL('http://localhost:3000/api/bitmap-proof?i=42');
      const request = new NextRequest(url, {
        headers: {
          'X-Session-ID': sessionId,
        },
      });

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'bitmap proof');

      expect(response.status).toBe(401);
      expect(getStringProperty(payload, 'error')).toBe('SESSION_CAPABILITY_REQUIRED');
    });

    it('should return error for invalid index format', async () => {
      const url = new URL('http://localhost:3000/api/bitmap-proof?i=invalid');
      const request = createAuthedRequest(url);

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'bitmap proof');

      expect(response.status).toBe(400);
      expect(getStringProperty(payload, 'code')).toBe('INVALID_INDEX');
    });

    it('should return error for invalid bitmap kind', async () => {
      const url = new URL('http://localhost:3000/api/bitmap-proof?i=1&kind=unknown');
      const request = createAuthedRequest(url);

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'bitmap proof');

      expect(response.status).toBe(400);
      expect(getStringProperty(payload, 'code')).toBe('INVALID_BITMAP_KIND');
    });

    it('should return error for negative index', async () => {
      const url = new URL('http://localhost:3000/api/bitmap-proof?i=-1');
      const request = createAuthedRequest(url);

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'bitmap proof');

      expect(response.status).toBe(400);
      expect(getStringProperty(payload, 'code')).toBe('INVALID_INDEX');
    });

    it('should return error for index out of range', async () => {
      const testBitmap = Array.from({ length: 100 }, () => false);

      const storedData: StoredBitmapData = {
        sessionId: 'test-session-123',
        includedBitmap: testBitmap,
        includedBitmapRoot: '0xabcdef123456789',
        treeSize: 100,
        finalizedAt: Date.now(),
      };

      getBitmapDataMock.mockResolvedValue(storedData);

      const url = new URL('http://localhost:3000/api/bitmap-proof?i=100');
      const request = createAuthedRequest(url);

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'bitmap proof');

      expect(response.status).toBe(400);
      expect(getStringProperty(payload, 'code')).toBe('INVALID_INDEX');
    });

    it('should return error when bitmap data not found', async () => {
      getBitmapDataMock.mockResolvedValue(null);

      const url = new URL('http://localhost:3000/api/bitmap-proof?i=42');
      const request = createAuthedRequest(url);

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'bitmap proof');

      expect(response.status).toBe(404);
      expect(getStringProperty(payload, 'code')).toBe('BITMAP_NOT_FOUND');
    });

    it('fails closed when finalized bitmap-proof state is corrupt', async () => {
      const now = Date.now();
      getSessionMock.mockResolvedValue({
        sessionId,
        contractGeneration: resolveCurrentContractGeneration(),
        finalizationArtifactState: 'corrupt_or_unreadable',
        votes: new Map(),
        botCount: 0,
        finalized: true,
        createdAt: now,
        lastActivity: now,
      });

      const url = new URL('http://localhost:3000/api/bitmap-proof?i=42');
      const request = createAuthedRequest(url);

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'bitmap proof');

      expect(response.status).toBe(500);
      expect(getStringProperty(payload, 'error')).toBe('CORRUPT_OR_UNREADABLE_FINALIZED_STATE');
      expect(getStringProperty(payload, 'artifactState')).toBe('corrupt_or_unreadable');
      expect(getBitmapDataMock).not.toHaveBeenCalled();
    });

    it('should handle single-leaf bitmap', async () => {
      // Small bitmap that fits in one leaf (256 bits)
      const testBitmap = Array.from({ length: 200 }, () => false);
      testBitmap[50] = true;

      const storedData: StoredBitmapData = {
        sessionId: 'test-session-123',
        includedBitmap: testBitmap,
        includedBitmapRoot: '0xabcdef123456789',
        treeSize: 200,
        finalizedAt: Date.now(),
      };

      getBitmapDataMock.mockResolvedValue(storedData);

      const url = new URL('http://localhost:3000/api/bitmap-proof?i=50');
      const request = createAuthedRequest(url);

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'bitmap proof');
      const leafChunk = getStringProperty(payload, 'leafChunk');
      const auditPath = isRecord(payload) && Array.isArray(payload.auditPath) ? payload.auditPath : [];

      expect(response.status).toBe(200);
      expect(leafChunk).toHaveLength(64);
      expect(auditPath).toHaveLength(0); // Single leaf = no siblings
    });

    it('should handle multi-leaf bitmap', async () => {
      // Bitmap spanning multiple leaves
      const testBitmap = Array.from({ length: 1024 }, () => false); // 4 leaves
      testBitmap[300] = true; // In second leaf

      const storedData: StoredBitmapData = {
        sessionId: 'test-session-123',
        includedBitmap: testBitmap,
        includedBitmapRoot: '0xabcdef123456789',
        treeSize: 1024,
        finalizedAt: Date.now(),
      };

      getBitmapDataMock.mockResolvedValue(storedData);

      const url = new URL('http://localhost:3000/api/bitmap-proof?i=300');
      const request = createAuthedRequest(url);

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'bitmap proof');
      const leafChunk = getStringProperty(payload, 'leafChunk');
      const auditPath = isRecord(payload) && Array.isArray(payload.auditPath) ? payload.auditPath : [];

      expect(response.status).toBe(200);
      expect(leafChunk).toHaveLength(64);
      expect(auditPath.length).toBeGreaterThan(0);
    });

    it('should include proper cache headers', async () => {
      const testBitmap = Array.from({ length: 100 }, () => false);
      testBitmap[10] = true;

      const storedData: StoredBitmapData = {
        sessionId: 'test-session-123',
        includedBitmap: testBitmap,
        includedBitmapRoot: '0xabcdef123456789',
        treeSize: 100,
        finalizedAt: Date.now(),
      };

      getBitmapDataMock.mockResolvedValue(storedData);

      const url = new URL('http://localhost:3000/api/bitmap-proof?i=10');
      const request = createAuthedRequest(url);

      const response = await GET(request);

      expect(response.status).toBe(200);

      // Check cache headers
      const cacheControl = response.headers.get('Cache-Control');
      expect(cacheControl).toContain('private');
      expect(cacheControl).toContain('max-age=');
      expect(cacheControl).toContain('stale-while-revalidate=');
      expect(cacheControl).toContain('immutable');

      const vary = response.headers.get('Vary');
      expect(vary).toContain('X-Session-ID');
      expect(vary).toContain('X-Session-Capability');

      const etag = response.headers.get('ETag');
      expect(etag).toBeDefined();
    });

    it('should support conditional requests with ETag', async () => {
      const testBitmap = Array.from({ length: 100 }, () => false);

      const storedData: StoredBitmapData = {
        sessionId: 'test-session-123',
        includedBitmap: testBitmap,
        includedBitmapRoot: '0xabcdef123456789',
        treeSize: 100,
        finalizedAt: Date.now(),
      };

      getBitmapDataMock.mockResolvedValue(storedData);

      // First request
      const url1 = new URL('http://localhost:3000/api/bitmap-proof?i=10');
      const request1 = createAuthedRequest(url1);
      const response1 = await GET(request1);
      const etag = response1.headers.get('ETag');
      if (!etag) {
        throw new Error('Expected ETag to be set');
      }

      // Second request with If-None-Match
      const url2 = new URL('http://localhost:3000/api/bitmap-proof?i=10');
      const request2 = createAuthedRequest(url2, {
        headers: {
          'If-None-Match': etag,
        },
      });
      const response2 = await GET(request2);

      expect(response2.status).toBe(304); // Not Modified
    });

    it('should accept strong ETag values for conditional requests', async () => {
      const testBitmap = Array.from({ length: 100 }, () => false);

      const storedData: StoredBitmapData = {
        sessionId: 'test-session-123',
        includedBitmap: testBitmap,
        includedBitmapRoot: '0xabcdef123456789',
        treeSize: 100,
        finalizedAt: Date.now(),
      };

      getBitmapDataMock.mockResolvedValue(storedData);

      const url1 = new URL('http://localhost:3000/api/bitmap-proof?i=10');
      const request1 = createAuthedRequest(url1);
      const response1 = await GET(request1);
      const etag = response1.headers.get('ETag');
      if (!etag) {
        throw new Error('Expected ETag to be set');
      }

      const strongEtag = etag.startsWith('W/') ? etag.slice(2) : etag;
      const url2 = new URL('http://localhost:3000/api/bitmap-proof?i=10');
      const request2 = createAuthedRequest(url2, {
        headers: {
          'If-None-Match': strongEtag,
        },
      });
      const response2 = await GET(request2);

      expect(response2.status).toBe(304);
    });

    it('should handle store errors gracefully', async () => {
      getBitmapDataMock.mockRejectedValue(new Error('Database connection failed'));

      const url = new URL('http://localhost:3000/api/bitmap-proof?i=42');
      const request = createAuthedRequest(url);

      const response = await GET(request);
      const payload = await readJsonRecord(response, 'bitmap proof');

      expect(response.status).toBe(500);
      expect(getStringProperty(payload, 'code')).toBe('INTERNAL_ERROR');
      expect(getStringProperty(payload, 'error')).toBeDefined();
    });

    it('should validate index is non-negative integer', async () => {
      const testCases = [
        { input: '3.14', valid: false },
        { input: '1e10', valid: false },
        { input: 'Infinity', valid: false },
        { input: 'NaN', valid: false },
        { input: '0', valid: true },
        { input: '42', valid: true },
      ];

      // Setup mock data for all test cases (even invalid ones need mock data to avoid 404)
      const testBitmap = Array.from({ length: 100 }, () => false);
      const storedData: StoredBitmapData = {
        sessionId: 'test-session-123',
        includedBitmap: testBitmap,
        includedBitmapRoot: '0xabcdef123456789',
        treeSize: 100,
        finalizedAt: Date.now(),
      };

      for (const testCase of testCases) {
        // Reset mock for each test case
        getBitmapDataMock.mockResolvedValue(storedData);

        const url = new URL(`http://localhost:3000/api/bitmap-proof?i=${testCase.input}`);
        const request = createAuthedRequest(url);

        const response = await GET(request);

        if (testCase.valid) {
          expect(response.status).toBe(200);
        } else {
          expect(response.status).toBe(400);
          const payload = await readJsonRecord(response, 'bitmap proof');
          expect(getStringProperty(payload, 'code')).toBe('INVALID_INDEX');
        }
      }
    });
  });

  describe('Security', () => {
    it('should prevent path traversal attacks', async () => {
      const maliciousInputs = [
        '../../../etc/passwd',
        '..\\..\\..\\windows\\system32',
        '0; cat /etc/passwd',
        '0 && rm -rf /',
      ];

      for (const input of maliciousInputs) {
        const url = new URL(`http://localhost:3000/api/bitmap-proof?i=${encodeURIComponent(input)}`);
        const request = createAuthedRequest(url);

        const response = await GET(request);
        const payload = await readJsonRecord(response, 'bitmap proof');

        expect(response.status).toBe(400);
        expect(getStringProperty(payload, 'code')).toBe('INVALID_INDEX');
      }
    });

    it('should handle very large index values', async () => {
      const url = new URL('http://localhost:3000/api/bitmap-proof?i=999999999999');
      const request = createAuthedRequest(url);

      const response = await GET(request);

      // Should either reject as invalid or handle gracefully
      expect([400, 404]).toContain(response.status);
    });
  });
});
