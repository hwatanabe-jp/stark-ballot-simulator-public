import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_STH_SOURCE_TEMPLATE,
  acquireSthEvidenceFromProviders,
  admitExternalSthProviderResponse,
  resolveSthVerificationFromProviders,
} from './sthProvider';

const baseJournal = {
  sthDigest: `0x${'a'.repeat(64)}`,
  bulletinRoot: `0x${'b'.repeat(64)}`,
  treeSize: 64,
};

const canonicalSthRecord = {
  ...baseJournal,
  timestamp: 1_730_000_000_000,
  logId: 'log-1',
};

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('admitExternalSthProviderResponse', () => {
  it('admits only the canonical flat external-auditor record', () => {
    expect(admitExternalSthProviderResponse('https://auditor.example/sth', canonicalSthRecord)).toEqual({
      source: 'https://auditor.example/sth',
      ...canonicalSthRecord,
    });
  });

  it.each([
    ['same-origin wrapper', { sth: canonicalSthRecord }],
    ['digest alias', { ...canonicalSthRecord, sthDigest: undefined, digest: baseJournal.sthDigest }],
    ['root alias', { ...canonicalSthRecord, bulletinRoot: undefined, root: baseJournal.bulletinRoot }],
    ['log ID alias', { ...canonicalSthRecord, logId: undefined, log_id: 'log-1' }],
  ])('rejects the %s instead of applying a provider fallback', (_case, providerRecord) => {
    expect(admitExternalSthProviderResponse('https://auditor.example/sth', providerRecord)).toBeNull();
  });

  it.each([
    ['treeSize', { ...canonicalSthRecord, treeSize: 'bad' }],
    ['bulletinRoot', { ...canonicalSthRecord, bulletinRoot: 123 }],
    ['timestamp', { ...canonicalSthRecord, timestamp: Number.NaN }],
    ['logId', { ...canonicalSthRecord, logId: '' }],
  ])('rejects a malformed canonical %s field fail-closed', (_field, providerRecord) => {
    expect(admitExternalSthProviderResponse('https://auditor.example/sth', providerRecord)).toBeNull();
  });
});

describe('acquireSthEvidenceFromProviders', () => {
  it('resolves the exact same-origin template with the typed route builder and does not self-fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const sameOriginProvider = vi.fn().mockReturnValue({ sth: canonicalSthRecord });

    const evidence = await acquireSthEvidenceFromProviders({
      sources: [`${SESSION_STH_SOURCE_TEMPLATE}?auditorId=local-auditor`],
      sessionId: 'session-1',
      sameOriginProvider,
      fetchImpl: fetchMock,
    });

    expect(sameOriginProvider).toHaveBeenCalledWith({
      auditorId: 'local-auditor',
      resolvedPath: '/api/sessions/session-1/bulletin/sth?auditorId=local-auditor',
      sourceTemplate: `${SESSION_STH_SOURCE_TEMPLATE}?auditorId=local-auditor`,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(evidence).toEqual([
      {
        kind: 'admitted',
        value: {
          source: '/api/sessions/session-1/bulletin/sth?auditorId=local-auditor',
          ...canonicalSthRecord,
        },
      },
    ]);
  });

  it('treats absolute HTTPS URLs as external and never attaches repository auth headers', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(response(canonicalSthRecord)));
    const sameOriginProvider = vi.fn();

    const evidence = await acquireSthEvidenceFromProviders({
      sources: ['https://app.example/auditor/sth', 'https://auditor.example/sth'],
      sessionId: 'session-1',
      sameOriginProvider,
      fetchImpl: fetchMock,
    });

    expect(sameOriginProvider).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Session-Capability')).toBeNull();
    }
    expect(evidence.every((item) => item.kind === 'admitted')).toBe(true);
  });

  it('classifies unavailable, malformed, and transport-failed evidence explicitly', async () => {
    const missingLocal = await acquireSthEvidenceFromProviders({
      sources: [SESSION_STH_SOURCE_TEMPLATE],
      sessionId: 'session-1',
      fetchImpl: vi.fn<typeof fetch>(),
    });
    expect(missingLocal[0]).toMatchObject({ kind: 'unavailable' });

    const malformed = await acquireSthEvidenceFromProviders({
      sources: ['/api/sth', 'https://auditor.example/sth'],
      sessionId: 'session-1',
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response({ sth: canonicalSthRecord })),
    });
    expect(malformed.map((item) => item.kind)).toEqual(['malformed', 'malformed']);

    const transportFailed = await acquireSthEvidenceFromProviders({
      sources: ['https://auditor.example/sth'],
      sessionId: 'session-1',
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error('network unavailable')),
    });
    expect(transportFailed[0]).toMatchObject({ kind: 'transport_failed' });
  });
});

describe('resolveSthVerificationFromProviders', () => {
  it('makes any malformed configured source fail consensus even when admitted records meet the threshold', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(canonicalSthRecord))
      .mockResolvedValueOnce(response({ sth: canonicalSthRecord }));

    const result = await resolveSthVerificationFromProviders({
      sources: ['https://auditor-a.example/sth', 'https://auditor-b.example/sth'],
      sessionId: 'session-1',
      journal: baseJournal,
      minMatchingSources: 1,
      fetchImpl: fetchMock,
    });

    expect(result.verified).toBe(false);
    expect(result.matchingSources).toBe(1);
    expect(result.sourcesChecked).toBe(2);
    expect(result.errors.join('\n')).toMatch(/Malformed STH response/);
  });

  it('preserves consensus and min-match behavior for admitted evidence', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(canonicalSthRecord))
      .mockResolvedValueOnce(
        response({
          ...canonicalSthRecord,
          sthDigest: `0x${'c'.repeat(64)}`,
        }),
      );

    const result = await resolveSthVerificationFromProviders({
      sources: ['https://auditor-a.example/sth', 'https://auditor-b.example/sth'],
      sessionId: 'session-1',
      journal: baseJournal,
      minMatchingSources: 1,
      fetchImpl: fetchMock,
    });

    expect(result.verified).toBe(false);
    expect(result.consensus).toBe(false);
    expect(result.matchingSources).toBe(1);
  });
});
