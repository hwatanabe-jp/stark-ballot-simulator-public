import { describe, expect, it, afterEach } from 'vitest';
import { Hono } from 'hono';
import { toApiContext } from './hono';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import { readJsonRecord } from '@/lib/testing/response-helpers';
import { getStringProperty } from '@/lib/utils/guards';

describe('toApiContext (Hono)', () => {
  const originalTrustedProxy = process.env.TRUSTED_PROXY;

  afterEach(() => {
    if (originalTrustedProxy === undefined) {
      delete process.env.TRUSTED_PROXY;
    } else {
      process.env.TRUSTED_PROXY = originalTrustedProxy;
    }
  });

  it('maps request, store, params, and client IP', async () => {
    process.env.TRUSTED_PROXY = 'api-gateway';
    // Given
    const store = createMockVoteStore();
    const app = new Hono();

    app.get('/api/test', (context) => {
      const apiContext = toApiContext({
        context,
        store,
        params: { voteId: 'vote-123' },
      });

      return context.json({
        requestUrl: apiContext.request.url,
        clientIp: apiContext.clientIp ?? null,
        param: apiContext.params?.voteId ?? null,
        storeMatch: apiContext.store === store,
      });
    });

    // When
    const request = new Request('http://localhost/api/test', {
      headers: {
        'x-forwarded-for': '203.0.113.10, 203.0.113.11',
      },
    });
    const response = await app.fetch(request, {
      requestContext: {
        http: {
          sourceIp: '203.0.113.80',
        },
      },
    });

    // Then
    expect(response.status).toBe(200);
    const payload = await readJsonRecord(response, 'hono adapter response');
    expect(getStringProperty(payload, 'requestUrl')).toBe('http://localhost/api/test');
    expect(getStringProperty(payload, 'clientIp')).toBe('203.0.113.80');
    expect(getStringProperty(payload, 'param')).toBe('vote-123');
    expect(payload.storeMatch).toBe(true);
  });

  it('uses Lambda requestContext sourceIp as fallback when headers are not trusted', async () => {
    process.env.TRUSTED_PROXY = 'none';
    const store = createMockVoteStore();
    const app = new Hono();

    app.get('/api/test', (context) => {
      const apiContext = toApiContext({
        context,
        store,
      });

      return context.json({
        clientIp: apiContext.clientIp ?? null,
      });
    });

    const request = new Request('http://localhost/api/test');
    const response = await app.fetch(request, {
      requestContext: {
        http: {
          sourceIp: '203.0.113.90',
        },
      },
    });

    expect(response.status).toBe(200);
    const payload = await readJsonRecord(response, 'hono adapter fallback response');
    expect(getStringProperty(payload, 'clientIp')).toBe('203.0.113.90');
  });

  it('uses right-most ALB x-forwarded-for as fallback via getConnInfo when requestContext sourceIp is absent', async () => {
    process.env.TRUSTED_PROXY = 'none';
    const store = createMockVoteStore();
    const app = new Hono();

    app.get('/api/test', (context) => {
      const apiContext = toApiContext({
        context,
        store,
      });

      return context.json({
        clientIp: apiContext.clientIp ?? null,
      });
    });

    const request = new Request('http://localhost/api/test', {
      headers: {
        'x-forwarded-for': '198.51.100.15, 203.0.113.200',
      },
    });
    const response = await app.fetch(request, {
      requestContext: {},
    });

    expect(response.status).toBe(200);
    const payload = await readJsonRecord(response, 'hono adapter ALB fallback response');
    expect(getStringProperty(payload, 'clientIp')).toBe('203.0.113.200');
  });
});
