import { describe, expect, vi, beforeEach, afterEach, it } from 'vitest';
import { resolveCurrentContractGeneration } from '@/lib/contract';

// Mock AWS credential provider and SigV4 signer before importing the store module
const signMock = vi.fn();
const signatureCtorMock = vi.fn();

class MockSignatureV4 {
  sign = signMock;

  constructor(config: { region?: string }) {
    signatureCtorMock(config);
  }
}

vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: vi.fn(
    () => () =>
      Promise.resolve({
        accessKeyId: 'AKIA_TEST',
        secretAccessKey: 'secret',
        sessionToken: 'token',
      }),
  ),
}));

vi.mock('@smithy/signature-v4', () => ({
  SignatureV4: MockSignatureV4,
}));

vi.mock('@aws-crypto/sha256-js', () => ({
  Sha256: vi.fn(),
}));

const originalEnv = process.env;

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return headers;
}

function getNormalizedFetchHeaders(call: Parameters<typeof fetch> | undefined): Record<string, string> {
  if (!call) {
    return {};
  }
  const headers = normalizeHeaders(call[1]?.headers);
  return Object.keys(headers).reduce<Record<string, string>>((acc, key) => {
    acc[key.toLowerCase()] = headers[key];
    return acc;
  }, {});
}

describe('AmplifySessionStore SigV4 integration', () => {
  beforeEach(() => {
    signMock.mockReset();
    signatureCtorMock.mockClear();
    process.env = { ...originalEnv };
    process.env.AMPLIFY_DATA_ENDPOINT = 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql';
    process.env.AMPLIFY_DATA_TTL_SECONDS = '300';
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { ping: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.resetModules();
    process.env = originalEnv;
  });

  it('signs requests with SigV4 using execution-role credentials', async () => {
    process.env.AWS_REGION = 'ap-northeast-1';
    signMock.mockImplementation((req: unknown) =>
      Promise.resolve({
        ...(req as object),
        headers: {
          ...(req as { headers?: Record<string, string> }).headers,
          Authorization: 'AWS4-HMAC-SHA256 ...',
          'x-amz-date': '20251018T000000Z',
        },
      }),
    );

    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();

    await (store as unknown as { execute<T>(q: string, v: Record<string, unknown>): Promise<T> }).execute(
      'query Test { ping }',
      {},
    );

    expect(signMock).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const fetchArgs = vi.mocked(fetch).mock.calls[0];
    const normalized = getNormalizedFetchHeaders(fetchArgs);
    expect(normalized['authorization']).toBe('AWS4-HMAC-SHA256 ...');
    expect(normalized['x-api-key']).toBeUndefined();
    const signerArgs = signatureCtorMock.mock.calls[0]?.[0] as { region: string } | undefined;
    expect(signerArgs?.region).toBe('ap-northeast-1');
  });

  it('handles null listVotingSessions.items when counting active sessions', async () => {
    process.env.AWS_REGION = 'ap-northeast-1';
    signMock.mockResolvedValue({
      headers: {
        Authorization: 'AWS4-HMAC-SHA256 ...',
        'x-amz-date': '20251018T000000Z',
      },
    });

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: { listVotingSessions: { items: null, nextToken: null } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();

    const count = await store.getActiveSessionCount();

    expect(count).toBe(0);
  });

  it('excludes fail-closed and unreadable live records when counting active sessions', async () => {
    process.env.AWS_REGION = 'ap-northeast-1';
    signMock.mockResolvedValue({
      headers: {
        Authorization: 'AWS4-HMAC-SHA256 ...',
        'x-amz-date': '20251018T000000Z',
      },
    });

    const nowSeconds = Math.floor(Date.now() / 1000);
    const currentGeneration = resolveCurrentContractGeneration();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            listVotingSessions: {
              items: [
                {
                  id: 'session-active',
                  contractGeneration: currentGeneration,
                  finalizationArtifactState: null,
                  ttl: nowSeconds + 300,
                  finalized: false,
                  lastActivity: new Date().toISOString(),
                  finalizationResultJson: null,
                },
                {
                  id: 'session-tombstone',
                  contractGeneration: currentGeneration,
                  finalizationArtifactState: 'unsupported_current_artifact',
                  ttl: nowSeconds + 300,
                  finalized: false,
                  lastActivity: new Date().toISOString(),
                  finalizationResultJson: null,
                },
                {
                  id: 'session-unreadable',
                  contractGeneration: currentGeneration,
                  finalizationArtifactState: null,
                  ttl: nowSeconds + 300,
                  finalized: false,
                  lastActivity: new Date().toISOString(),
                  finalizationResultJson: '{"broken":',
                },
                {
                  id: 'session-stale',
                  contractGeneration: 'stale-contract-generation',
                  finalizationArtifactState: null,
                  ttl: nowSeconds + 300,
                  finalized: false,
                  lastActivity: new Date().toISOString(),
                  finalizationResultJson: null,
                },
              ],
              nextToken: null,
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();

    const count = await store.getActiveSessionCount();

    expect(count).toBe(1);
  });

  it('infers region from AppSync endpoint when AWS_REGION is unset', async () => {
    delete process.env.AWS_REGION;
    signMock.mockImplementation((req: unknown) =>
      Promise.resolve({
        ...(req as object),
        headers: {
          ...(req as { headers?: Record<string, string> }).headers,
          Authorization: 'AWS4-HMAC-SHA256 ...',
          'x-amz-date': '20251018T000000Z',
        },
      }),
    );

    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();

    await (store as unknown as { execute<T>(q: string, v: Record<string, unknown>): Promise<T> }).execute(
      'query Test { ping }',
      {},
    );

    const signerArgs = signatureCtorMock.mock.calls[0]?.[0] as { region: string } | undefined;
    expect(signerArgs?.region).toBe('ap-northeast-1');
  });

  it('throws when region cannot be inferred for SigV4', async () => {
    process.env.AMPLIFY_DATA_ENDPOINT = 'https://example.invalid/graphql';
    delete process.env.AWS_REGION;

    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();

    await expect(
      (store as unknown as { execute<T>(q: string, v: Record<string, unknown>): Promise<T> }).execute(
        'query Test { ping }',
        {},
      ),
    ).rejects.toThrow('[AmplifySessionStore] AWS region could not be inferred.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('surfaces SigV4 signer failures', async () => {
    process.env.AWS_REGION = 'ap-northeast-1';
    signMock.mockImplementation(() => Promise.reject(new Error('sign failure')));

    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();

    await expect(
      (store as unknown as { execute<T>(q: string, v: Record<string, unknown>): Promise<T> }).execute(
        'query Test { ping }',
        {},
      ),
    ).rejects.toThrow('sign failure');
  });

  it('signs requests without COGNITO_IDENTITY_POOL_ID', async () => {
    delete process.env.COGNITO_IDENTITY_POOL_ID;
    process.env.AWS_REGION = 'ap-northeast-1';
    delete process.env.AMPLIFY_DATA_API_KEY;

    signMock.mockImplementation((req: unknown) =>
      Promise.resolve({
        ...(req as object),
        headers: {
          ...(req as { headers?: Record<string, string> }).headers,
          Authorization: 'AWS4-HMAC-SHA256 ...',
          'x-amz-date': '20251101T000000Z',
        },
      }),
    );

    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();

    await (store as unknown as { execute<T>(q: string, v: Record<string, unknown>): Promise<T> }).execute(
      'query Test { ping }',
      {},
    );

    expect(signMock).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Verify SigV4 headers are present
    const fetchArgs = vi.mocked(fetch).mock.calls[0];
    const normalized = getNormalizedFetchHeaders(fetchArgs);
    expect(normalized['authorization']).toBe('AWS4-HMAC-SHA256 ...');
  });
});
