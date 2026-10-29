import { admitSessionIdentity } from '@stark-ballot/web/session/identity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadBundle, fetchVerificationReport, type DownloadCandidate, type ReportCandidate } from './artifacts';
import {
  clearPublicRuntimeEnvForTests,
  setPublicRuntimeEnvForTests,
} from '@stark-ballot/runtime-config/env/public-runtime-config';
import type { VerifierServiceWireReport } from '@stark-ballot/verification/verifier-service-report';

const originalCreateObjectURL = URL.createObjectURL.bind(URL);
const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
const identity = admitSessionIdentity({ sessionId: 'session-1', capabilityToken: 'capability-token' });
const authenticatedBundleCandidate: DownloadCandidate = {
  kind: 'bundle',
  source: 'authenticated-endpoint',
  url: '/api/sessions/session-1/finalizations/exec-1/artifacts/bundle',
  sessionId: 'session-1',
  finalizationId: 'exec-1',
};
const authenticatedReportCandidate: ReportCandidate = {
  kind: 'report',
  source: 'authenticated-endpoint',
  url: '/api/sessions/session-1/finalizations/exec-1/artifacts/report',
  sessionId: 'session-1',
  finalizationId: 'exec-1',
};
const expectedImageId = `0x${'a'.repeat(64)}`;

function verifierWireReport(status: VerifierServiceWireReport['status']): VerifierServiceWireReport {
  const common = {
    verifier_version: '0.1.0',
    verified_at: '2026-08-11T09:10:11Z',
    duration_ms: 10,
    expected_image_id: expectedImageId,
    bundle_path: 'bundle.zip',
    receipt_path: 'receipt.json',
  } as const;

  switch (status) {
    case 'success':
      return {
        status,
        ...common,
        receipt_image_id: expectedImageId,
        dev_mode_receipt: false,
      };
    case 'dev_mode':
      return {
        status,
        ...common,
        receipt_image_id: null,
        dev_mode_receipt: true,
        errors: ['development receipt'],
      };
    case 'failed':
      return {
        status,
        ...common,
        receipt_image_id: null,
        dev_mode_receipt: false,
        errors: ['verification failed'],
      };
  }
}

function s3ObjectUrl(hostParts: string[], objectPath: string): string {
  return `https://${hostParts.join('.')}/${objectPath}`;
}

beforeEach(() => {
  setPublicRuntimeEnvForTests('VITE_RUNTIME_PROFILE', 'static-mock-e2e');
});

describe('downloadBundle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearPublicRuntimeEnvForTests();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: originalCreateObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: originalRevokeObjectURL,
    });
  });

  it('rejects an invalid authenticated endpoint selector before issuing an authenticated fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      downloadBundle(
        {
          kind: 'bundle',
          source: 'authenticated-endpoint',
          url: 'http://localhost/api/sessions/session-1/progress',
          sessionId: 'session-1',
          finalizationId: '../progress',
        },
        {
          identity,
        },
      ),
    ).rejects.toThrow('Invalid bundle download reference');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects raw S3-shaped candidates before issuing a fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      downloadBundle(
        {
          kind: 'bundle',
          source: 's3',
          url: s3ObjectUrl(['example-bucket', 's3', 'amazonaws', 'com'], 'bundle.zip'),
        } as unknown as DownloadCandidate,
        { identity },
      ),
    ).rejects.toThrow('Invalid bundle download reference');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('downloads trusted authenticated endpoint candidates with session auth headers', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('bundle', { status: 200, headers: { 'Content-Type': 'application/zip' } }));
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURLMock = vi.fn(() => 'blob:bundle');
    const revokeObjectURLMock = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURLMock,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURLMock,
    });
    const anchor = document.createElement('a');
    const clickMock = vi.fn();
    const removeMock = vi.fn();
    anchor.click = clickMock;
    anchor.remove = removeMock;
    vi.spyOn(document, 'createElement').mockReturnValue(anchor);

    await downloadBundle(
      {
        kind: 'bundle',
        source: 'authenticated-endpoint',
        url: '/api/sessions/session-1/finalizations/exec-1/artifacts/bundle',
        sessionId: 'session-1',
        finalizationId: 'exec-1',
      },
      {
        identity,
      },
    );

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session-1/finalizations/exec-1/artifacts/bundle', {
      headers: {
        'X-Session-Capability': 'capability-token',
        Range: 'bytes=0-4194303',
      },
    });
    expect(anchor.download).toMatch(/^stark-ballot-verification-bundle-/);
    expect(clickMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:bundle');
  });

  it('assembles ranged authenticated bundle chunks when the endpoint returns partial content', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('0123', {
          status: 206,
          headers: {
            'Content-Range': 'bytes 0-3/10',
            'Accept-Ranges': 'bytes',
            'X-Stark-Bundle-Range-Chunk-Size': '4',
            ETag: '"bundle-etag"',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response('4567', {
          status: 206,
          headers: {
            'Content-Range': 'bytes 4-7/10',
            'Accept-Ranges': 'bytes',
            'X-Stark-Bundle-Range-Chunk-Size': '4',
            ETag: '"bundle-etag"',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response('89', {
          status: 206,
          headers: {
            'Content-Range': 'bytes 8-9/10',
            'Accept-Ranges': 'bytes',
            'X-Stark-Bundle-Range-Chunk-Size': '4',
            ETag: '"bundle-etag"',
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    let downloadedBlob: Blob | undefined;
    const createObjectURLMock = vi.fn((blob: Blob) => {
      downloadedBlob = blob;
      return 'blob:bundle';
    });
    const revokeObjectURLMock = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURLMock,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURLMock,
    });
    const anchor = document.createElement('a');
    anchor.click = vi.fn();
    anchor.remove = vi.fn();
    vi.spyOn(document, 'createElement').mockReturnValue(anchor);

    await downloadBundle(
      {
        kind: 'bundle',
        source: 'authenticated-endpoint',
        url: '/api/sessions/session-1/finalizations/exec-1/artifacts/bundle',
        sessionId: 'session-1',
        finalizationId: 'exec-1',
      },
      {
        identity,
      },
    );

    expect(fetchMock.mock.calls.map((call) => new Headers(call[1]?.headers).get('Range'))).toEqual([
      'bytes=0-4194303',
      'bytes=4-7',
      'bytes=8-9',
    ]);
    expect(downloadedBlob).toBeDefined();
    expect(await downloadedBlob?.text()).toBe('0123456789');
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:bundle');
  });

  it.each([
    {
      name: 'an oversized advertised total',
      response: new Response('0123', {
        status: 206,
        headers: { 'Content-Range': `bytes 0-3/${256 * 1024 * 1024 + 1}` },
      }),
    },
    {
      name: 'a malformed content range',
      response: new Response('0123', {
        status: 206,
        headers: { 'Content-Range': 'bytes invalid' },
      }),
    },
    {
      name: 'a body shorter than its advertised range',
      response: new Response('012', {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-3/4', ETag: '"bundle-etag"' },
      }),
    },
    {
      name: 'a body longer than its advertised range',
      response: new Response('01234', {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-3/4', ETag: '"bundle-etag"' },
      }),
    },
    {
      name: 'a response without a representation identity',
      response: new Response('0123', {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-3/4' },
      }),
    },
  ])('rejects $name before saving a ranged bundle', async ({ response }) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response));
    const createObjectURLMock = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURLMock,
    });

    await expect(downloadBundle(authenticatedBundleCandidate, { identity })).rejects.toThrow(
      'Invalid ranged bundle response',
    );

    expect(createObjectURLMock).not.toHaveBeenCalled();
  });

  it('rejects a later range that does not exactly match the requested interval', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('0123', {
          status: 206,
          headers: {
            'Content-Range': 'bytes 0-3/8',
            'X-Stark-Bundle-Range-Chunk-Size': '4',
            ETag: '"bundle-etag"',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response('456', {
          status: 206,
          headers: {
            'Content-Range': 'bytes 4-6/8',
            'X-Stark-Bundle-Range-Chunk-Size': '4',
            ETag: '"bundle-etag"',
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadBundle(authenticatedBundleCandidate, { identity })).rejects.toThrow(
      'Invalid ranged bundle response',
    );
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Range')).toBe('bytes=4-7');
  });

  it('rejects a representation identity change between ranged responses', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('0123', {
          status: 206,
          headers: {
            'Content-Range': 'bytes 0-3/8',
            'X-Stark-Bundle-Range-Chunk-Size': '4',
            ETag: '"bundle-etag"',
            'X-Amz-Version-Id': 'version-1',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response('4567', {
          status: 206,
          headers: {
            'Content-Range': 'bytes 4-7/8',
            'X-Stark-Bundle-Range-Chunk-Size': '4',
            ETag: '"bundle-etag"',
            'X-Amz-Version-Id': 'version-2',
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadBundle(authenticatedBundleCandidate, { identity })).rejects.toThrow(
      'Bundle representation changed during download',
    );
  });

  it('caps an oversized server-advertised chunk size at the local 4 MiB request bound', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('0123', {
          status: 206,
          headers: {
            'Content-Range': `bytes 0-3/${8 * 1024 * 1024}`,
            'X-Stark-Bundle-Range-Chunk-Size': String(64 * 1024 * 1024),
            ETag: '"bundle-etag"',
          },
        }),
      )
      .mockResolvedValueOnce(new Response('range unavailable', { status: 416 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadBundle(authenticatedBundleCandidate, { identity })).rejects.toThrow('HTTP 416');
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Range')).toBe('bytes=4-4194307');
  });

  it('rejects a full bundle response whose declared size exceeds the client bound', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response('bundle', {
          status: 200,
          headers: { 'Content-Length': String(256 * 1024 * 1024 + 1) },
        }),
      ),
    );

    await expect(downloadBundle(authenticatedBundleCandidate, { identity })).rejects.toThrow(
      'Bundle download exceeds size limit',
    );
  });
});

describe('fetchVerificationReport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearPublicRuntimeEnvForTests();
  });

  it('rejects non-report candidates before issuing an authenticated fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchVerificationReport(
        {
          kind: 'bundle',
          source: 'authenticated-endpoint',
          url: '/api/sessions/session-1/finalizations/exec-1/artifacts/bundle',
          sessionId: 'session-1',
          finalizationId: 'exec-1',
        } as unknown as ReportCandidate,
        { identity },
      ),
    ).rejects.toThrow('Invalid verification report reference');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unconfigured cross-origin report candidates before sending session auth headers', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchVerificationReport(
        {
          kind: 'report',
          source: 'authenticated-endpoint',
          url: 'https://api.example.com/api/sessions/session-1/finalizations/exec-1/artifacts/report',
          sessionId: 'session-1',
          finalizationId: 'exec-1',
        },
        {
          identity,
        },
      ),
    ).rejects.toThrow('Invalid verification report reference');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches configured cross-origin report candidates with session auth headers and no range header', async () => {
    setPublicRuntimeEnvForTests('VITE_API_BASE_URL', 'https://api.example.com');
    const report = verifierWireReport('success');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(report), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchVerificationReport(
        {
          kind: 'report',
          source: 'authenticated-endpoint',
          url: 'https://api.example.com/api/sessions/session-1/finalizations/exec-1/artifacts/report',
          sessionId: 'session-1',
          finalizationId: 'exec-1',
        },
        {
          identity,
        },
      ),
    ).resolves.toEqual(report);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/sessions/session-1/finalizations/exec-1/artifacts/report',
      {
        headers: {
          'X-Session-Capability': 'capability-token',
        },
      },
    );
  });

  it('rejects raw cross-origin report URLs even when an API origin is configured', async () => {
    setPublicRuntimeEnvForTests('VITE_API_BASE_URL', 'https://api.example.com');
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchVerificationReport(
        {
          kind: 'report',
          source: 'authenticated-endpoint',
          url: s3ObjectUrl(['bucket', 's3', 'amazonaws', 'com'], 'private/verification-report.json'),
          sessionId: 'session-1',
          finalizationId: 'exec-1',
        },
        {
          identity,
        },
      ),
    ).rejects.toThrow('Invalid verification report reference');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['success', 'dev_mode', 'failed'] as const)(
    'admits a coherent %s report from a trusted same-origin endpoint',
    async (status) => {
      const report = verifierWireReport(status);
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(report), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchVerificationReport(authenticatedReportCandidate, { identity })).resolves.toEqual(report);

      expect(fetchMock).toHaveBeenCalledWith(authenticatedReportCandidate.url, {
        headers: {
          'X-Session-Capability': 'capability-token',
        },
      });
    },
  );

  it('rejects the former incomplete success report shape', async () => {
    const report = { status: 'success', duration_ms: 10 };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(report), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchVerificationReport(authenticatedReportCandidate, { identity })).rejects.toThrow(
      'Invalid verification report response',
    );
  });

  it.each([
    {
      label: 'an unknown key',
      report: { ...verifierWireReport('success'), private_path: '/tmp/private/report.json' },
    },
    {
      label: 'a missing required path',
      report: (() => {
        const report: Record<string, unknown> = { ...verifierWireReport('success') };
        delete report['receipt_path'];
        return report;
      })(),
    },
    {
      label: 'an incoherent success status',
      report: { ...verifierWireReport('success'), dev_mode_receipt: true },
    },
  ])('rejects a protected report with $label', async ({ report }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(report), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(fetchVerificationReport(authenticatedReportCandidate, { identity })).rejects.toThrow(
      'Invalid verification report response',
    );
  });

  it('rejects a protected report whose declared size exceeds 4 MiB', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response('{"status":"success"}', {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(4 * 1024 * 1024 + 1),
          },
        }),
      ),
    );

    await expect(fetchVerificationReport(authenticatedReportCandidate, { identity })).rejects.toThrow(
      'Verification report exceeds size limit',
    );
  });

  it('rejects a protected report whose received body exceeds 4 MiB without a content length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response('x'.repeat(4 * 1024 * 1024 + 1), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(fetchVerificationReport(authenticatedReportCandidate, { identity })).rejects.toThrow(
      'Verification report exceeds size limit',
    );
  });
});
