import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { handle, type LambdaEvent } from '@hono/aws-lambda';
import { describe, expect, it } from 'vitest';
import { resolveAwsRequestId, resolveAwsRequestContextSourceIp } from './hono';

function restEvent(overrides: Record<string, unknown> = {}): LambdaEvent {
  // The AWS REST wire has no version property (the adapter type requires one).
  return {
    resource: '/api/{proxy+}',
    httpMethod: 'GET',
    path: '/api/echo',
    body: null,
    headers: {},
    multiValueHeaders: {},
    isBase64Encoded: false,
    queryStringParameters: {},
    multiValueQueryStringParameters: {},
    requestContext: {
      accountId: '000000000000',
      apiId: 'example',
      authorizer: {},
      domainName: 'example.execute-api.ap-northeast-1.amazonaws.com',
      domainPrefix: 'example',
      extendedRequestId: 'trusted-rest-id=',
      requestId: 'client-overridden-id',
      httpMethod: 'GET',
      identity: { sourceIp: '203.0.113.4', userAgent: 'fixture' },
      path: '/live/api/echo',
      protocol: 'HTTP/1.1',
      requestTime: '',
      requestTimeEpoch: 0,
      resourcePath: '/api/{proxy+}',
      stage: 'live',
    },
    ...overrides,
  } as LambdaEvent;
}

describe('actual Hono REST Lambda transport', () => {
  it('keeps stage out of routing and prefers multi-value headers/query without trusting supplied IDs or IPs', async () => {
    const app = new Hono().get('/api/echo', (context) =>
      context.json({
        id: resolveAwsRequestId(context),
        ip: resolveAwsRequestContextSourceIp(context),
        capability: context.req.header('X-Session-Capability'),
        query: context.req.queries('q'),
      }),
    );
    const result = await handle(app)(
      restEvent({
        headers: { 'x-request-id': 'spoofed', 'x-forwarded-for': '192.0.2.1', 'x-session-capability': 'single' },
        multiValueHeaders: { 'X-Session-Capability': ['first', 'second'] },
        queryStringParameters: { q: 'ignored' },
        multiValueQueryStringParameters: { q: ['a b', 'x/y'] },
      }),
    );
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      id: 'trusted-rest-id=',
      ip: '203.0.113.4',
      capability: 'first, second',
      query: ['a b', 'x/y'],
    });
    expect(result.isBase64Encoded).toBe(false);
  });

  it('decodes base64 JSON bodies and URL-encoded path parameters exactly once', async () => {
    const app = new Hono().post('/api/echo/:id', async (context) =>
      context.json({ id: context.req.param('id'), body: await context.req.json() }),
    );
    const result = await handle(app)(
      restEvent({
        httpMethod: 'POST',
        path: '/api/echo/hello%20world',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: Buffer.from('{"reason":"😀"}').toString('base64'),
        isBase64Encoded: true,
      }),
    );
    expect(JSON.parse(result.body)).toEqual({ id: 'hello world', body: { reason: '😀' } });
  });

  it('preserves maximum Range bytes and headers below the buffered Lambda limit', async () => {
    const bytes = new Uint8Array(4 * 1024 * 1024).fill(193);
    const app = new Hono().get(
      '/api/echo',
      () =>
        new Response(bytes, {
          status: 206,
          headers: {
            'content-type': 'application/zip',
            etag: '"artifact"',
            'content-range': `bytes 0-${bytes.length - 1}/${bytes.length + 1}`,
            'accept-ranges': 'bytes',
          },
        }),
    );
    const result = await handle(app)(restEvent({ headers: { accept: 'text/html,application/zip' } }));
    expect(result.statusCode).toBe(206);
    expect(result.isBase64Encoded).toBe(true);
    expect(createHash('sha256').update(Buffer.from(result.body, 'base64')).digest('hex')).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    expect(result.multiValueHeaders?.['etag']).toEqual(['"artifact"']);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(6 * 1024 * 1024);
  });

  it.each([304, 416])('preserves conditional/error status %s', async (status) => {
    const app = new Hono().get('/api/echo', () => new Response(null, { status, headers: { etag: '"artifact"' } }));
    const result = await handle(app)(restEvent());
    expect(result.statusCode).toBe(status);
    expect(result.body).toBe('');
  });
});
