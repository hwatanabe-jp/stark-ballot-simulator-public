import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolvePublicBaseUrl } from '@/server/api/utils/publicBaseUrl';

const originalEnv = { ...process.env };

const restoreEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
};

describe('resolvePublicBaseUrl', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    restoreEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    restoreEnv();
  });

  it('prefers VERIFIER_PUBLIC_BASE_URL when configured', () => {
    process.env.VERIFIER_PUBLIC_BASE_URL = 'https://verifier.example.com/base';

    const request = new Request('https://fallback.example.com/api/verify');
    const result = resolvePublicBaseUrl(request);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.baseUrl).toBe('https://verifier.example.com/base');
    }
  });

  it('rejects invalid VERIFIER_PUBLIC_BASE_URL values', () => {
    process.env.VERIFIER_PUBLIC_BASE_URL = 'not-a-url';

    const request = new Request('https://fallback.example.com/api/verify');
    const result = resolvePublicBaseUrl(request);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain('VERIFIER_PUBLIC_BASE_URL');
    }
  });

  it('fails in production when VERIFIER_PUBLIC_BASE_URL is missing', () => {
    vi.stubEnv('NODE_ENV', 'production');
    delete process.env.VERIFIER_PUBLIC_BASE_URL;

    const request = new Request('https://fallback.example.com/api/verify');
    const result = resolvePublicBaseUrl(request);

    expect(result.ok).toBe(false);
  });

  it('uses forwarded headers in non-production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    delete process.env.VERIFIER_PUBLIC_BASE_URL;

    const request = new Request('https://fallback.example.com/api/verify', {
      headers: {
        'x-forwarded-host': 'preview.example.com',
        'x-forwarded-proto': 'http',
      },
    });

    const result = resolvePublicBaseUrl(request);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.baseUrl).toBe('http://preview.example.com');
    }
  });

  it('falls back to request origin in non-production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    delete process.env.VERIFIER_PUBLIC_BASE_URL;

    const request = new Request('https://fallback.example.com/api/verify');
    const result = resolvePublicBaseUrl(request);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.baseUrl).toBe('https://fallback.example.com');
    }
  });
});
