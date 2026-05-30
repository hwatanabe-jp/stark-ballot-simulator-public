import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadBundle } from './download';
import type { DownloadCandidate } from './verification-data';

const originalCreateObjectURL = URL.createObjectURL.bind(URL);
const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);

describe('downloadBundle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
          source: 'authenticated-endpoint',
          url: 'http://localhost/api/progress',
          sessionId: 'session-1',
          executionId: '../progress',
        },
        {
          authHeaders: {
            'X-Session-ID': 'session-1',
            'X-Session-Capability': 'capability-token',
          },
        },
      ),
    ).rejects.toThrow('Invalid bundle download reference');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects raw S3-shaped candidates before issuing a fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      downloadBundle({
        source: 's3',
        url: 'https://example-bucket.s3.amazonaws.com/bundle.zip',
      } as unknown as DownloadCandidate),
    ).rejects.toThrow('Invalid bundle download reference');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('downloads trusted authenticated endpoint candidates with session auth headers', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(new Blob(['bundle'], { type: 'application/zip' })),
    } as Response);
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
        source: 'authenticated-endpoint',
        url: '/api/verification/bundles/session-1/exec-1',
        sessionId: 'session-1',
        executionId: 'exec-1',
      },
      {
        authHeaders: {
          'X-Session-ID': 'session-1',
          'X-Session-Capability': 'capability-token',
        },
      },
    );

    expect(fetchMock).toHaveBeenCalledWith('/api/verification/bundles/session-1/exec-1', {
      headers: {
        'X-Session-ID': 'session-1',
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
        source: 'authenticated-endpoint',
        url: '/api/verification/bundles/session-1/exec-1',
        sessionId: 'session-1',
        executionId: 'exec-1',
      },
      {
        authHeaders: {
          'X-Session-ID': 'session-1',
          'X-Session-Capability': 'capability-token',
        },
      },
    );

    expect(fetchMock.mock.calls.map((call) => (call[1]?.headers as Record<string, string>).Range)).toEqual([
      'bytes=0-4194303',
      'bytes=4-7',
      'bytes=8-9',
    ]);
    expect(downloadedBlob).toBeDefined();
    expect(await downloadedBlob?.text()).toBe('0123456789');
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:bundle');
  });
});
