import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { verifySthThirdParty, resolveConfiguredSthSources, resolveConfiguredSthMinMatches } from '../sth-verifier';
import type { ZkVMJournal } from '@/lib/zkvm/types';
import { CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';
import { createTestJournal } from '@/lib/testing/test-helpers';

declare global {
  var __STH_SOURCES: string[] | undefined;
  var __STH_MIN_MATCHES: number | undefined;
}

const buildResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('sth-verifier', () => {
  const baseJournal: ZkVMJournal = {
    ...createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingIndices: 0,
      invalidIndices: 0,
      seenIndicesCount: 64,
    }),
    electionId: 'test-election',
    electionConfigHash: '0xhash',
    bulletinRoot: '0xnewroot',
    treeSize: 64,
    totalExpected: 64,
    sthDigest: '0xabc123',
    verifiedTally: [10, 10, 10, 10, 24],
    totalVotes: 64,
    validVotes: 64,
    invalidVotes: 0,
    seenIndicesCount: 64,
    missingSlots: 0,
    invalidPresentedSlots: 0,
    rejectedRecords: 0,
    includedBitmapRoot: '0xbitmap',
    excludedSlots: 0,
    inputCommitment: '0xinput',
    methodVersion: CURRENT_METHOD_VERSION,
  };

  const matchingResponse = {
    sthDigest: baseJournal.sthDigest,
    treeSize: baseJournal.treeSize,
    bulletinRoot: baseJournal.bulletinRoot,
    timestamp: 1_725_000_000_000,
  };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete globalThis.__STH_SOURCES;
    delete globalThis.__STH_MIN_MATCHES;
    delete process.env.NEXT_PUBLIC_STH_MIN_MATCHES;
  });

  it('should fail when no sources are configured', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const result = await verifySthThirdParty(baseJournal, { sources: [], fetchImpl: fetchMock });

    expect(result.verified).toBe(false);
    expect(result.errors[0]).toContain('No STH sources configured');
  });

  it('should verify consensus across configured sources', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(buildResponse(matchingResponse))
      .mockResolvedValueOnce(buildResponse(matchingResponse));

    const result = await verifySthThirdParty(baseJournal, {
      sources: ['https://auditor.example/sth1', 'https://auditor.example/sth2'],
      fetchImpl: fetchMock,
    });

    expect(result.verified).toBe(true);
    expect(result.consensus).toBe(true);
    expect(result.matchingSources).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it('should report mismatch when sources disagree', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(buildResponse(matchingResponse))
      .mockResolvedValueOnce(
        buildResponse({
          ...matchingResponse,
          sthDigest: '0xdeadbeef',
        }),
      );

    const result = await verifySthThirdParty(baseJournal, {
      sources: ['https://auditor.example/sth1', 'https://auditor.example/sth2'],
      fetchImpl: fetchMock,
    });

    expect(result.verified).toBe(false);
    expect(result.consensus).toBe(false);
    expect(result.errors.some((msg) => msg.includes('digest mismatch'))).toBe(true);
  });

  it('should respect global override configuration', () => {
    globalThis.__STH_SOURCES = ['https://auditor.example/sth'];
    const resolved = resolveConfiguredSthSources();
    expect(resolved).toEqual(['https://auditor.example/sth']);
  });

  describe('resolveConfiguredSthMinMatches', () => {
    it('should default to 2 when unset', () => {
      expect(resolveConfiguredSthMinMatches()).toBe(2);
    });

    it('should read from NEXT_PUBLIC_STH_MIN_MATCHES', () => {
      process.env.NEXT_PUBLIC_STH_MIN_MATCHES = '1';
      expect(resolveConfiguredSthMinMatches()).toBe(1);
    });

    it('should ignore invalid values and keep default', () => {
      process.env.NEXT_PUBLIC_STH_MIN_MATCHES = '0';
      expect(resolveConfiguredSthMinMatches()).toBe(2);
    });
  });

  describe('same-origin auth headers', () => {
    it('includes session auth headers for relative same-origin sources', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(buildResponse(matchingResponse));

      await verifySthThirdParty(baseJournal, {
        sources: ['/api/sth'],
        fetchImpl: fetchMock,
        sessionId: 'test-session-123',
        sameOriginHeaders: {
          'X-Session-ID': 'test-session-123',
          'X-Session-Capability': 'capability-token',
        },
      });

      const callArgs = fetchMock.mock.calls[0];
      expect(callArgs[0]).toBe('/api/sth');
      const init = callArgs[1];
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Session-ID')).toBe('test-session-123');
      expect(headers.get('X-Session-Capability')).toBe('capability-token');
    });

    it('does not leak session auth headers to cross-origin sources', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(buildResponse(matchingResponse));

      await verifySthThirdParty(baseJournal, {
        sources: ['https://auditor.example/sth'],
        fetchImpl: fetchMock,
        sessionId: 'test-session-123',
        sameOriginHeaders: {
          'X-Session-ID': 'test-session-123',
          'X-Session-Capability': 'capability-token',
        },
        sameOriginOrigin: 'https://app.example.com',
      });

      const callArgs = fetchMock.mock.calls[0];
      const init = callArgs[1];
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Session-ID')).toBeNull();
      expect(headers.get('X-Session-Capability')).toBeNull();
    });

    it('should merge additional headers with same-origin session auth headers', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(buildResponse(matchingResponse));

      await verifySthThirdParty(baseJournal, {
        sources: ['/api/sth'],
        fetchImpl: fetchMock,
        sessionId: 'test-session-123',
        sameOriginHeaders: {
          'X-Session-ID': 'test-session-123',
          'X-Session-Capability': 'capability-token',
        },
        headers: { 'X-Custom-Header': 'custom-value' },
      });

      const callArgs = fetchMock.mock.calls[0];
      expect(callArgs[0]).toBe('/api/sth');
      const init = callArgs[1];
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Session-ID')).toBe('test-session-123');
      expect(headers.get('X-Session-Capability')).toBe('capability-token');
      expect(headers.get('X-Custom-Header')).toBe('custom-value');
    });

    it('same-origin headers override conflicting custom headers', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(buildResponse(matchingResponse));

      await verifySthThirdParty(baseJournal, {
        sources: ['/api/sth'],
        fetchImpl: fetchMock,
        sessionId: 'override-session',
        sameOriginHeaders: {
          'X-Session-ID': 'override-session',
          'X-Session-Capability': 'override-capability',
        },
        headers: {
          'X-Session-ID': 'original-session',
          'X-Session-Capability': 'original-capability',
        },
      });

      const callArgs = fetchMock.mock.calls[0];
      expect(callArgs[0]).toBe('/api/sth');
      const init = callArgs[1];
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Session-ID')).toBe('override-session');
      expect(headers.get('X-Session-Capability')).toBe('override-capability');
    });
  });
});
