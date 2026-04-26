/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpRequest } from '@smithy/protocol-http';
import { resolveAppSyncRegion } from '../appsyncRegionResolver';
import { signedAppSyncFetch } from '../appsyncSignedFetch';
import type { SignatureV4 } from '@smithy/signature-v4';

const signMock = vi.fn();
const fetchMock = vi.fn();

function createSigner(): SignatureV4 {
  return {
    sign: signMock,
  } as unknown as SignatureV4;
}

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

describe('resolveAppSyncRegion', () => {
  it('prefers AMPLIFY_DATA_REGION', () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AMPLIFY_DATA_REGION: 'us-west-2',
      AWS_REGION: 'eu-west-1',
    };
    const url = new URL('https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql');

    expect(resolveAppSyncRegion(url, env)).toBe('us-west-2');
  });

  it('falls back to AWS_REGION', () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AWS_REGION: 'eu-west-1',
    };
    const url = new URL('https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql');

    expect(resolveAppSyncRegion(url, env)).toBe('eu-west-1');
  });

  it('parses region from appsync-api hostname', () => {
    const url = new URL('https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql');

    expect(resolveAppSyncRegion(url, {} as NodeJS.ProcessEnv)).toBe('ap-northeast-1');
  });

  it('parses region from appsync-realtime-api hostname', () => {
    const url = new URL('https://example.appsync-realtime-api.us-east-1.amazonaws.com/graphql');

    expect(resolveAppSyncRegion(url, {} as NodeJS.ProcessEnv)).toBe('us-east-1');
  });

  it('returns undefined when region cannot be resolved', () => {
    const url = new URL('https://example.invalid/graphql');

    expect(resolveAppSyncRegion(url, {} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe('signedAppSyncFetch', () => {
  beforeEach(() => {
    signMock.mockReset();
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('signs HttpRequest with query params and normalizes headers', async () => {
    signMock.mockImplementation((request: unknown) => ({
      ...(request as HttpRequest),
      headers: {
        ...(request as HttpRequest).headers,
        host: 'example.appsync-api.ap-northeast-1.amazonaws.com',
        Authorization: 'AWS4-HMAC-SHA256 ...',
        'x-amz-date': '20251101T000000Z',
      },
    }));
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const endpoint = 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql?foo=bar&foo=baz';

    const response = await signedAppSyncFetch({
      endpoint,
      body: JSON.stringify({ query: 'query Ping { ping }' }),
      signer: createSigner(),
    });

    expect(response.ok).toBe(true);
    expect(signMock).toHaveBeenCalledTimes(1);
    const signedRequest = signMock.mock.calls[0]?.[0] as HttpRequest;
    expect(signedRequest).toBeInstanceOf(HttpRequest);
    expect(signedRequest.path).toBe('/graphql');
    expect(signedRequest.query).toEqual({ foo: ['bar', 'baz'] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchArgs = fetchMock.mock.calls[0] as Parameters<typeof fetch>;
    const headers = normalizeHeaders(fetchArgs[1]?.headers);
    expect(headers.host).toBeUndefined();
    expect(headers['content-type']).toBe('application/json');
    expect(headers.Authorization).toBe('AWS4-HMAC-SHA256 ...');
  });
});
