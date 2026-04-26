import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildRequestLogContext } from '@/server/http/requestLogging';
import { hashIpForLogging } from '@/lib/utils/logging';

describe('buildRequestLogContext', () => {
  beforeEach(() => {
    vi.stubEnv('LOG_IP_HASH_SALT', 'test-salt');
    vi.stubEnv('TRUSTED_PROXY', 'api-gateway');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('includes request metadata and omits source_ip_hash without fallbackIp in api-gateway mode', () => {
    const request = new Request('https://ballot.example.com/api/verify', {
      method: 'GET',
      headers: {
        'x-request-id': 'req-123',
        host: 'ballot.example.com',
        'x-forwarded-host': 'api-gateway.example.com',
        referer: 'https://ballot.example.com/',
        'x-forwarded-for': '203.0.113.9',
      },
    });

    const context = buildRequestLogContext(request);

    expect(context.requestId).toBe('req-123');
    expect(context.http?.method).toBe('GET');
    expect(context.http?.path).toBe('/api/verify');
    expect(context.http?.host).toBe('ballot.example.com');
    expect(context.http?.x_forwarded_host).toBe('api-gateway.example.com');
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
});
