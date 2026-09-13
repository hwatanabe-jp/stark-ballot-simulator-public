import { describe, expect, it, afterEach } from 'vitest';
import { Hono } from 'hono';
import { resolveAwsRequestId, toApiHandlerContext } from './hono';
import { createMockVoteStore } from '../../test-support/mockVoteStore';
import { readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { getStringProperty } from '@stark-ballot/validation/unknown-value-guards';
import { localRuntimeProfile } from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';

const runtimeProfile = localRuntimeProfile();

describe('toApiHandlerContext (Hono)', () => {
  const originalTrustedProxy = process.env['TRUSTED_PROXY'];

  afterEach(() => {
    if (originalTrustedProxy === undefined) {
      delete process.env['TRUSTED_PROXY'];
    } else {
      process.env['TRUSTED_PROXY'] = originalTrustedProxy;
    }
  });

  it('maps trusted request metadata, store, and client IP', async () => {
    process.env['TRUSTED_PROXY'] = 'api-gateway';
    // Given
    const store = createMockVoteStore();
    const app = new Hono();

    app.get('/api/test', (context) => {
      const apiContext = toApiHandlerContext({
        context,
        runtimeProfile,
        store,
        requestId: 'request-123',
        operatorGatedDevelop: false,
      });

      return context.json({
        requestOrigin: apiContext.requestOrigin,
        requestId: apiContext.requestId,
        clientIp: apiContext.clientIp ?? null,
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
    expect(getStringProperty(payload, 'requestOrigin')).toBe('http://localhost');
    expect(getStringProperty(payload, 'requestId')).toBe('request-123');
    expect(getStringProperty(payload, 'clientIp')).toBe('203.0.113.80');
    expect(payload['storeMatch']).toBe(true);
  });

  it('uses Lambda requestContext sourceIp as fallback when headers are not trusted', async () => {
    process.env['TRUSTED_PROXY'] = 'none';
    const store = createMockVoteStore();
    const app = new Hono();

    app.get('/api/test', (context) => {
      const apiContext = toApiHandlerContext({
        context,
        runtimeProfile,
        store,
        requestId: 'request-123',
        operatorGatedDevelop: false,
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
    process.env['TRUSTED_PROXY'] = 'none';
    const store = createMockVoteStore();
    const app = new Hono();

    app.get('/api/test', (context) => {
      const apiContext = toApiHandlerContext({
        context,
        runtimeProfile,
        store,
        requestId: 'request-123',
        operatorGatedDevelop: false,
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

  it('resolves the trusted request ID only from API Gateway requestContext', async () => {
    const app = new Hono();
    app.get('/api/test', (context) =>
      context.json({
        requestId: resolveAwsRequestId(context),
      }),
    );

    const request = new Request('http://localhost/api/test', {
      headers: {
        'x-request-id': 'forged-client-id',
        'x-amzn-requestid': 'also-forged',
      },
    });
    const response = await app.fetch(request, {
      requestContext: {
        requestId: 'trusted-gateway-id',
      },
    });

    const payload = await readJsonRecord(response, 'trusted request-id response');
    expect(getStringProperty(payload, 'requestId')).toBe('trusted-gateway-id');
  });

  it('does not resolve a request ID from headers or malformed gateway context', async () => {
    const app = new Hono();
    app.get('/api/test', (context) =>
      context.json({
        requestId: resolveAwsRequestId(context),
      }),
    );

    const response = await app.fetch(
      new Request('http://localhost/api/test', {
        headers: { 'x-request-id': 'forged-client-id' },
      }),
      { requestContext: { requestId: '   ' } },
    );

    const payload = await readJsonRecord(response, 'missing trusted request-id response');
    expect(payload['requestId']).toBeNull();
  });
});
