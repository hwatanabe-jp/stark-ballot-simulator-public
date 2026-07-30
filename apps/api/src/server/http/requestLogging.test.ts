import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildRequestLogContext, resolveUntrustedClientRequestId, withTrustedRequestIdHeader } from './requestLogging';
import { hashIpForLogging } from '@stark-ballot/diagnostics/logging';

describe('buildRequestLogContext', () => {
  beforeEach(() => {
    vi.stubEnv('LOG_IP_HASH_SALT', 'test-salt');
    vi.stubEnv('TRUSTED_PROXY', 'api-gateway');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses only the supplied trusted request ID and a route template', () => {
    const request = new Request(
      'https://ballot.example.com/api/verification/bundles/550e8400-e29b-41d4-a716-446655440000/execution-1?raw=private',
      {
        method: 'GET',
        headers: {
          'x-request-id': 'forged-client-request-id',
          host: 'ballot.example.com',
          'x-forwarded-host': 'api-gateway.example.com',
          referer: 'https://ballot.example.com/',
          'x-forwarded-for': '203.0.113.9',
        },
      },
    );

    const context = buildRequestLogContext(request, {
      requestId: 'trusted-gateway-request-id',
      routePath: '/api/verification/bundles/:sessionId/:executionId',
    });

    expect(context.requestId).toBe('trusted-gateway-request-id');
    expect(context.http?.method).toBe('GET');
    expect(context.http?.path).toBe('/api/verification/bundles/:sessionId/:executionId');
    expect(context.http).not.toHaveProperty('host');
    expect(context.http).not.toHaveProperty('x_forwarded_host');
    expect(context.http).not.toHaveProperty('referer');
    expect(context.http?.source_ip_hash).toBeUndefined();
  });

  it('includes source_ip_hash when fallbackIp is provided', () => {
    const request = new Request('https://ballot.example.com/api/verify', {
      method: 'GET',
      headers: {
        host: 'ballot.example.com',
        'x-forwarded-host': 'api-gateway.example.com',
        'x-forwarded-for': '203.0.113.9',
      },
    });

    const context = buildRequestLogContext(request, { fallbackIp: '203.0.113.9' });

    expect(context.http?.source_ip_hash).toBe(hashIpForLogging('203.0.113.9'));
  });

  it('generates a trusted local request ID instead of trusting request headers', () => {
    const request = new Request('http://localhost/api/progress', {
      headers: {
        'x-request-id': 'forged-client-request-id',
        'x-amzn-requestid': 'also-forged',
        'x-amzn-trace-id': 'Root=1-also-forged',
      },
    });

    const context = buildRequestLogContext(request, { routePath: '/api/progress' });

    expect(context.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(context.requestId).not.toContain('forged');
  });

  it('retains only bounded simple client request IDs as explicitly untrusted', () => {
    expect(resolveUntrustedClientRequestId(new Headers({ 'x-request-id': 'client-ref_123.abc' }))).toBe(
      'client-ref_123.abc',
    );

    for (const unsafeValue of [
      '550e8400-e29b-41d4-a716-446655440000',
      '/api/sessions/550e8400-e29b-41d4-a716-446655440000/status',
      '/api/verification/bundles/550e8400-e29b-41d4-a716-446655440000/execution-1',
      'session-550e8400-e29b-41d4-a716-446655440000',
      'v1.ABCDEFGHIJKLMNOP.QRSTUVWXYZabcdef',
      'x'.repeat(129),
    ]) {
      expect(resolveUntrustedClientRequestId(new Headers({ 'x-request-id': unsafeValue }))).toBeUndefined();
    }
  });

  it('adds correlation without failing on an immutable response header guard', () => {
    const immutableResponse = Response.redirect('https://example.invalid/result', 302);

    const correlatedResponse = withTrustedRequestIdHeader(immutableResponse, 'trusted-request-id');

    expect(correlatedResponse.status).toBe(302);
    expect(correlatedResponse.headers.get('location')).toBe('https://example.invalid/result');
    expect(correlatedResponse.headers.get('x-request-id')).toBe('trusted-request-id');
  });
});
