import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApiError, ErrorCode } from '@/lib/errors/apiErrors';
import { getRequestIp, validateTurnstileToken } from '@/lib/security/turnstile';

const originalEnv = { ...process.env };
const AMPLIFY_RUNTIME_SECRET_PLACEHOLDER = '<value will be resolved during runtime>';

describe('validateTurnstileToken', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    Object.assign(process.env, originalEnv);
    process.env.TURNSTILE_BYPASS = '0';
    process.env.TURNSTILE_SECRET_KEY = '';
    process.env.TURNSTILE_ALLOWED_HOSTNAMES = '';
    delete process.env.TRUSTED_PROXY;
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('skips verification when bypass flag is enabled', async () => {
    vi.stubEnv('AWS_BRANCH', 'develop');
    process.env.TURNSTILE_BYPASS = '1';

    await expect(validateTurnstileToken({ token: null })).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not bypass when runtime classification is unknown', async () => {
    vi.stubEnv('AWS_BRANCH', '');
    vi.stubEnv('AMPLIFY_BRANCH', '');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', '');
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', '');
    vi.stubEnv('ENV_NAME', '');
    process.env.TURNSTILE_BYPASS = '1';
    delete process.env.TURNSTILE_SECRET_KEY;

    await expect(validateTurnstileToken({ token: 'cf-turnstile-token' })).rejects.toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not allow bypass in production runtime', async () => {
    vi.stubEnv('AWS_BRANCH', 'main');
    process.env.TURNSTILE_BYPASS = '1';
    process.env.TURNSTILE_SECRET_KEY = 'live-secret';

    await expect(validateTurnstileToken({ token: undefined })).rejects.toMatchObject({
      code: ErrorCode.CAPTCHA_FAILED,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when secret is missing and bypass is disabled', async () => {
    vi.stubEnv('AWS_BRANCH', 'main');
    process.env.TURNSTILE_BYPASS = '0';
    delete process.env.TURNSTILE_SECRET_KEY;

    await expect(validateTurnstileToken({ token: 'cf-turnstile-token' })).rejects.toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when secret is unresolved Amplify placeholder', async () => {
    vi.stubEnv('AWS_BRANCH', 'main');
    process.env.TURNSTILE_BYPASS = '0';
    process.env.TURNSTILE_SECRET_KEY = AMPLIFY_RUNTIME_SECRET_PLACEHOLDER;

    await expect(validateTurnstileToken({ token: 'cf-turnstile-token' })).rejects.toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows bypass on develop runtime', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AWS_BRANCH', 'develop');
    process.env.TURNSTILE_BYPASS = '1';

    await expect(validateTurnstileToken({ token: undefined })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws an error when token is missing under enforcement', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';

    await expect(validateTurnstileToken({ token: undefined })).rejects.toMatchObject({
      code: ErrorCode.CAPTCHA_FAILED,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends verification request to Cloudflare when configured', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'live-secret';

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      validateTurnstileToken({ token: 'cf-turnstile-token', remoteIp: '203.0.113.5' }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    const init = call[1];
    const body = init?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    if (body instanceof URLSearchParams) {
      expect(body.get('secret')).toBe('live-secret');
      expect(body.get('response')).toBe('cf-turnstile-token');
      expect(body.get('remoteip')).toBe('203.0.113.5');
    }
  });

  it('throws ApiError when Cloudflare responds with failure', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'live-secret';

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: false, 'error-codes': ['timeout-or-duplicate'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(validateTurnstileToken({ token: 'invalid-token' })).rejects.toBeInstanceOf(ApiError);
  });

  it('rejects when action does not match expected action', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'live-secret';

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, action: 'vote', hostname: 'ballot.example.com' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      validateTurnstileToken({ token: 'cf-turnstile-token', expectedAction: 'finalize' }),
    ).rejects.toMatchObject({
      code: ErrorCode.CAPTCHA_FAILED,
    });
  });

  it('rejects when hostname is not in the allowlist', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'live-secret';
    process.env.TURNSTILE_ALLOWED_HOSTNAMES = 'ballot.example.com';

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, hostname: 'evil.example' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(validateTurnstileToken({ token: 'cf-turnstile-token' })).rejects.toMatchObject({
      code: ErrorCode.CAPTCHA_FAILED,
    });
  });

  it('accepts hostname values with protocol in allowlist', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'live-secret';
    process.env.TURNSTILE_ALLOWED_HOSTNAMES = 'https://ballot.example.com/';

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, hostname: 'ballot.example.com' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(validateTurnstileToken({ token: 'cf-turnstile-token' })).resolves.toBeUndefined();
  });
});

describe('getRequestIp', () => {
  it('prefers cf-connecting-ip header when Cloudflare is trusted', () => {
    process.env.TRUSTED_PROXY = 'cloudflare';
    // Given
    const headers = new Headers({
      'cf-connecting-ip': '203.0.113.10',
      'x-forwarded-for': '203.0.113.11',
      'x-real-ip': '203.0.113.12',
    });

    // When
    const ip = getRequestIp(headers, '198.51.100.1');

    // Then
    expect(ip).toBe('203.0.113.10');
  });

  it('uses fallback sourceIp when API Gateway is trusted', () => {
    process.env.TRUSTED_PROXY = 'api-gateway';
    // Given
    const headers = new Headers({
      'x-forwarded-for': '203.0.113.11, 203.0.113.12',
      'x-real-ip': '203.0.113.13',
    });

    // When
    const ip = getRequestIp(headers, '198.51.100.2');

    // Then
    expect(ip).toBe('198.51.100.2');
  });

  it('returns undefined for API Gateway mode when sourceIp fallback is missing', () => {
    process.env.TRUSTED_PROXY = 'api-gateway';
    // Given
    const headers = new Headers();

    // When
    const ip = getRequestIp(headers);

    // Then
    expect(ip).toBeUndefined();
  });

  it('returns fallback when proxy headers are not trusted', () => {
    process.env.TRUSTED_PROXY = 'none';
    // Given
    const headers = new Headers({
      'cf-connecting-ip': '203.0.113.10',
      'x-forwarded-for': '203.0.113.11',
      'x-real-ip': '203.0.113.12',
    });

    // When
    const ip = getRequestIp(headers, '198.51.100.1');

    // Then
    expect(ip).toBe('198.51.100.1');
  });
});
