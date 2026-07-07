import { describe, expect, it, vi } from 'vitest';
import { admitSthProviderResponse, resolveSthVerificationFromProviders } from './sthProvider';

const baseJournal = {
  sthDigest: `0x${'a'.repeat(64)}`,
  bulletinRoot: `0x${'b'.repeat(64)}`,
  treeSize: 64,
};

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('admitSthProviderResponse', () => {
  it('admits wrapped and unwrapped STH provider records', () => {
    expect(
      admitSthProviderResponse('https://auditor.example/sth', {
        sth: {
          sthDigest: baseJournal.sthDigest,
          bulletinRoot: baseJournal.bulletinRoot,
          treeSize: baseJournal.treeSize,
          log_id: 'log-1',
        },
      }),
    ).toEqual({
      source: 'https://auditor.example/sth',
      sthDigest: baseJournal.sthDigest,
      bulletinRoot: baseJournal.bulletinRoot,
      treeSize: baseJournal.treeSize,
      logId: 'log-1',
    });
  });

  it('rejects malformed provider records fail-closed', () => {
    expect(admitSthProviderResponse('https://auditor.example/sth', { sth: { treeSize: 64 } })).toBeNull();
    expect(admitSthProviderResponse('https://auditor.example/sth', 'not json')).toBeNull();
  });

  it.each([
    ['treeSize', { ...baseJournal, treeSize: 'bad' }],
    ['bulletinRoot', { ...baseJournal, bulletinRoot: 123 }],
    ['timestamp', { ...baseJournal, timestamp: Number.NaN }],
    ['logId', { ...baseJournal, logId: '' }],
  ])('rejects present malformed %s fields fail-closed', (_field, providerRecord) => {
    expect(admitSthProviderResponse('https://auditor.example/sth', providerRecord)).toBeNull();
  });

  it('rejects malformed primary fields instead of falling back to valid aliases', () => {
    expect(
      admitSthProviderResponse('https://auditor.example/sth', {
        ...baseJournal,
        bulletinRoot: 123,
        root: baseJournal.bulletinRoot,
      }),
    ).toBeNull();
  });
});

describe('resolveSthVerificationFromProviders', () => {
  it('forwards session auth headers only to same-origin sources', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(baseJournal));

    await resolveSthVerificationFromProviders({
      sources: ['/api/sth', 'https://app.example/api/sth-absolute', 'https://auditor.example/sth'],
      journal: baseJournal,
      minMatchingSources: 3,
      sameOriginOrigin: 'https://app.example',
      sameOriginHeaders: {
        'X-Session-ID': 'session-1',
        'X-Session-Capability': 'capability-token',
      },
      fetchImpl: fetchMock,
    });

    const sameOriginHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const sameOriginAbsoluteHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    const crossOriginHeaders = new Headers(fetchMock.mock.calls[2]?.[1]?.headers);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://app.example/api/sth');
    expect(sameOriginHeaders.get('X-Session-ID')).toBe('session-1');
    expect(sameOriginHeaders.get('X-Session-Capability')).toBe('capability-token');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://app.example/api/sth-absolute');
    expect(sameOriginAbsoluteHeaders.get('X-Session-ID')).toBe('session-1');
    expect(sameOriginAbsoluteHeaders.get('X-Session-Capability')).toBe('capability-token');
    expect(crossOriginHeaders.get('X-Session-ID')).toBeNull();
    expect(crossOriginHeaders.get('X-Session-Capability')).toBeNull();
  });

  it('does not forward session auth headers to protocol-relative cross-origin sources', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(baseJournal));

    await resolveSthVerificationFromProviders({
      sources: ['//evil.example/sth', '///evil.example/sth'],
      journal: baseJournal,
      minMatchingSources: 2,
      sameOriginOrigin: 'https://app.example',
      sameOriginHeaders: {
        'X-Session-ID': 'session-1',
        'X-Session-Capability': 'capability-token',
      },
      fetchImpl: fetchMock,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://evil.example/sth');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://evil.example/sth');

    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Session-ID')).toBeNull();
      expect(headers.get('X-Session-Capability')).toBeNull();
    }
  });

  it('fails closed for malformed or non-JSON provider responses', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ sth: { treeSize: 64 } }))
      .mockResolvedValueOnce(new Response('not json', { status: 200, headers: { 'Content-Type': 'text/plain' } }));

    const result = await resolveSthVerificationFromProviders({
      sources: ['https://auditor-a.example/sth', 'https://auditor-b.example/sth'],
      journal: baseJournal,
      minMatchingSources: 1,
      fetchImpl: fetchMock,
    });

    expect(result.verified).toBe(false);
    expect(result.sourcesChecked).toBe(2);
    expect(result.errors.join('\n')).toMatch(/Malformed STH response|Unexpected token|JSON/);
  });

  it('does not count malformed provider records toward the matching-source threshold', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(baseJournal))
      .mockResolvedValueOnce(response({ ...baseJournal, treeSize: 'bad' }));

    const result = await resolveSthVerificationFromProviders({
      sources: ['https://auditor-a.example/sth', 'https://auditor-b.example/sth'],
      journal: baseJournal,
      minMatchingSources: 2,
      fetchImpl: fetchMock,
    });

    expect(result.verified).toBe(false);
    expect(result.matchingSources).toBe(1);
    expect(result.errors.join('\n')).toMatch(/Malformed STH response/);
  });

  it('respects configured consensus and min-match behavior', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(baseJournal))
      .mockResolvedValueOnce(response({ ...baseJournal, sthDigest: `0x${'c'.repeat(64)}` }));

    const result = await resolveSthVerificationFromProviders({
      sources: ['https://auditor-a.example/sth', 'https://auditor-b.example/sth'],
      journal: baseJournal,
      minMatchingSources: 1,
      fetchImpl: fetchMock,
    });

    expect(result.verified).toBe(false);
    expect(result.consensus).toBe(false);
    expect(result.matchingSources).toBe(1);
  });
});
