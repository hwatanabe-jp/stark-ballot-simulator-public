import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApiError, ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { extractTurnstileToken, getRequestIp, validateTurnstileToken } from './turnstile';
import {
  clearRuntimeConfigReferenceResolver,
  installStaticRuntimeConfigReferenceResolver,
} from '@stark-ballot/runtime-config/env/runtimeConfigReferences';
import {
  localRuntimeProfile,
  targetRuntimeProfile,
  targetRuntimeProfileEnv,
} from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';
import { resolveRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

const UNRESOLVED_RUNTIME_SECRET_PLACEHOLDER = '<value will be resolved during runtime>';
const TURNSTILE_SECRET_REF = '/stark-ballot-simulator/stark-dev/develop/app/secrets/turnstile-secret-key';
const MAIN_TURNSTILE_SECRET_REF = '/stark-ballot-simulator/stark-prod/main/app/secrets/turnstile-secret-key';
const DEVELOP_REFERENCE_AUTHORITY = { expectedDeploymentEnvironment: 'develop' } as const;
const MAIN_REFERENCE_AUTHORITY = { expectedDeploymentEnvironment: 'main' } as const;
const LOCAL_RUNTIME_PROFILE = localRuntimeProfile();
const STATIC_MOCK_RUNTIME_PROFILE = localRuntimeProfile('static-mock-e2e');
const LOCAL_PROOF_DEVELOPMENT_RUNTIME_PROFILE = localRuntimeProfile('local-proof-development');
const LOCAL_PROOF_PRODUCTION_RUNTIME_PROFILE = localRuntimeProfile('local-proof-production');
const TARGET_RUNTIME_PROFILE = targetRuntimeProfile();
const TARGET_MAIN_RUNTIME_PROFILE = targetRuntimeProfile('main');

describe('validateTurnstileToken', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.stubEnv('TURNSTILE_SECRET_KEY', undefined);
    vi.stubEnv('TURNSTILE_ALLOWED_HOSTNAMES', undefined);
    vi.stubEnv('TURNSTILE_SECRET_KEY_REF', undefined);
    vi.stubEnv('TRUSTED_PROXY', undefined);
    clearRuntimeConfigReferenceResolver();
    installStaticRuntimeConfigReferenceResolver(
      new Map([[TURNSTILE_SECRET_REF, 'resolved-turnstile-secret']]),
      DEVELOP_REFERENCE_AUTHORITY,
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    clearRuntimeConfigReferenceResolver();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    ['local-demo', LOCAL_RUNTIME_PROFILE, null],
    ['static-mock-e2e', STATIC_MOCK_RUNTIME_PROFILE, undefined],
    ['local-proof-development', LOCAL_PROOF_DEVELOPMENT_RUNTIME_PROFILE, ''],
    ['local-proof-production', LOCAL_PROOF_PRODUCTION_RUNTIME_PROFILE, {}],
  ])('skips verification for the injected %s profile', async (_profileName, profile, token) => {
    await expect(validateTurnstileToken(profile, { token })).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a token for the injected target develop profile', async () => {
    await expect(validateTurnstileToken(TARGET_RUNTIME_PROFILE, { token: undefined })).rejects.toMatchObject({
      code: ErrorCode.CAPTCHA_FAILED,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a token for the injected target main profile', async () => {
    installStaticRuntimeConfigReferenceResolver(
      new Map([[MAIN_TURNSTILE_SECRET_REF, 'resolved-turnstile-secret']]),
      MAIN_REFERENCE_AUTHORITY,
    );

    await expect(validateTurnstileToken(TARGET_MAIN_RUNTIME_PROFILE, { token: undefined })).rejects.toMatchObject({
      code: ErrorCode.CAPTCHA_FAILED,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a blank token under target enforcement', async () => {
    await expect(validateTurnstileToken(TARGET_RUNTIME_PROFILE, { token: '   ' })).rejects.toMatchObject({
      code: ErrorCode.CAPTCHA_FAILED,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects direct Turnstile secret material for the injected target profile', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'direct-turnstile-secret');

    await expect(
      validateTurnstileToken(TARGET_MAIN_RUNTIME_PROFILE, { token: 'cf-turnstile-token' }),
    ).rejects.toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when the target secret reference cannot be resolved', async () => {
    clearRuntimeConfigReferenceResolver();

    await expect(
      validateTurnstileToken(TARGET_MAIN_RUNTIME_PROFILE, { token: 'cf-turnstile-token' }),
    ).rejects.toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when direct target secret material is an unresolved runtime placeholder', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', UNRESOLVED_RUNTIME_SECRET_PLACEHOLDER);

    await expect(validateTurnstileToken(TARGET_RUNTIME_PROFILE, { token: 'cf-turnstile-token' })).rejects.toMatchObject(
      {
        code: ErrorCode.INTERNAL_ERROR,
      },
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the injected local profile even with production-like non-selector environment values', async () => {
    const env = {
      NODE_ENV: 'production',
      TURNSTILE_SECRET_KEY: '',
    };

    await expect(validateTurnstileToken(LOCAL_RUNTIME_PROFILE, { token: undefined }, env)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a non-string token under target enforcement', async () => {
    await expect(validateTurnstileToken(TARGET_RUNTIME_PROFILE, { token: {} })).rejects.toMatchObject({
      code: ErrorCode.CAPTCHA_FAILED,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends verification request to Cloudflare when configured', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, hostname: 'develop.stark-ballot-sim.hwatanabe.dev' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      validateTurnstileToken(TARGET_RUNTIME_PROFILE, {
        token: 'cf-turnstile-token',
        remoteIp: '203.0.113.5',
      }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = strictDefined(fetchMock.mock.calls[0]);
    const init = call[1];
    const body = init?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    if (body instanceof URLSearchParams) {
      expect(body.get('secret')).toBe('resolved-turnstile-secret');
      expect(body.get('response')).toBe('cf-turnstile-token');
      expect(body.get('remoteip')).toBe('203.0.113.5');
    }
  });

  it('resolves the Turnstile secret from an approved target runtime reference', async () => {
    installStaticRuntimeConfigReferenceResolver(
      new Map([[TURNSTILE_SECRET_REF, 'resolved-turnstile-secret']]),
      DEVELOP_REFERENCE_AUTHORITY,
    );

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, hostname: 'develop.stark-ballot-sim.hwatanabe.dev' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      validateTurnstileToken(TARGET_RUNTIME_PROFILE, { token: 'cf-turnstile-token' }),
    ).resolves.toBeUndefined();

    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    if (body instanceof URLSearchParams) {
      expect(body.get('secret')).toBe('resolved-turnstile-secret');
    }
  });

  it('throws ApiError when Cloudflare responds with failure', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: false, 'error-codes': ['timeout-or-duplicate'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(validateTurnstileToken(TARGET_RUNTIME_PROFILE, { token: 'invalid-token' })).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('fails closed when Cloudflare returns non-JSON', async () => {
    fetchMock.mockResolvedValue(
      new Response('not json', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    await expect(validateTurnstileToken(TARGET_RUNTIME_PROFILE, { token: 'cf-turnstile-token' })).rejects.toMatchObject(
      {
        code: ErrorCode.CAPTCHA_FAILED,
        message: 'Turnstile verification returned malformed response',
      },
    );
  });

  it('fails closed when Cloudflare returns a malformed JSON object', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(validateTurnstileToken(TARGET_RUNTIME_PROFILE, { token: 'cf-turnstile-token' })).rejects.toMatchObject(
      {
        code: ErrorCode.CAPTCHA_FAILED,
        message: 'Turnstile verification returned malformed response',
      },
    );
  });

  it('rejects when action does not match expected action', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, action: 'vote', hostname: 'ballot.example.com' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      validateTurnstileToken(TARGET_RUNTIME_PROFILE, {
        token: 'cf-turnstile-token',
        expectedAction: 'finalize',
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.CAPTCHA_FAILED,
    });
  });

  it('rejects when hostname is not in the allowlist', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, hostname: 'evil.example' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(validateTurnstileToken(TARGET_RUNTIME_PROFILE, { token: 'cf-turnstile-token' })).rejects.toMatchObject(
      {
        code: ErrorCode.CAPTCHA_FAILED,
      },
    );
  });

  it('rejects URL-shaped target hostname configuration before Turnstile verification', () => {
    expect(() =>
      resolveRuntimeProfile({
        ...targetRuntimeProfileEnv(),
        TURNSTILE_ALLOWED_HOSTNAMES: 'https://ballot.example.com/',
      }),
    ).toThrow('TURNSTILE_ALLOWED_HOSTNAMES');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('extractTurnstileToken', () => {
  it('reads only the canonical turnstileToken field', () => {
    expect(extractTurnstileToken({ turnstileToken: 'canonical-token' })).toBe('canonical-token');
    expect(extractTurnstileToken({ 'cf-turnstile-response': 'vendor-token' })).toBeUndefined();
    expect(extractTurnstileToken({ cfTurnstileResponse: 'legacy-token' })).toBeUndefined();
  });
});

describe('getRequestIp', () => {
  const cloudflareProfile = resolveRuntimeProfile({
    ...targetRuntimeProfileEnv('main'),
    TRUSTED_PROXY: 'cloudflare',
  });

  it.each(['203.0.113.10', '2001:db8::1'])(
    'uses authenticated Cloudflare client IP %s for the production target',
    (clientIp) => {
      const headers = new Headers({
        'cf-connecting-ip': clientIp,
        'x-forwarded-for': '198.51.100.1',
        'x-real-ip': '198.51.100.2',
      });
      expect(getRequestIp(cloudflareProfile, headers, '198.51.100.3')).toBe(clientIp);
    },
  );

  it.each([null, '', 'unknown', '999.0.0.1', '1:2:3', '203.0.113.1, 203.0.113.2', '203.0.113.1:443', '[2001:db8::1]'])(
    'rejects absent or invalid Cloudflare client IP %s without trusting other proxy addresses',
    (clientIp) => {
      const headers = new Headers({ 'x-forwarded-for': '203.0.113.11', 'x-real-ip': '203.0.113.12' });
      if (clientIp !== null) headers.set('cf-connecting-ip', clientIp);
      expect(getRequestIp(cloudflareProfile, headers, '198.51.100.1')).toBeUndefined();
    },
  );

  it('prefers cf-connecting-ip header when Cloudflare is trusted', () => {
    process.env['TRUSTED_PROXY'] = 'cloudflare';
    // Given
    const headers = new Headers({
      'cf-connecting-ip': '203.0.113.10',
      'x-forwarded-for': '203.0.113.11',
      'x-real-ip': '203.0.113.12',
    });

    // When
    const ip = getRequestIp(LOCAL_RUNTIME_PROFILE, headers, '198.51.100.1');

    // Then
    expect(ip).toBe('203.0.113.10');
  });

  it('uses fallback sourceIp when API Gateway is trusted', () => {
    process.env['TRUSTED_PROXY'] = 'api-gateway';
    // Given
    const headers = new Headers({
      'x-forwarded-for': '203.0.113.11, 203.0.113.12',
      'x-real-ip': '203.0.113.13',
    });

    // When
    const ip = getRequestIp(LOCAL_RUNTIME_PROFILE, headers, '198.51.100.2');

    // Then
    expect(ip).toBe('198.51.100.2');
  });

  it('returns undefined for API Gateway mode when sourceIp fallback is missing', () => {
    process.env['TRUSTED_PROXY'] = 'api-gateway';
    // Given
    const headers = new Headers();

    // When
    const ip = getRequestIp(LOCAL_RUNTIME_PROFILE, headers);

    // Then
    expect(ip).toBeUndefined();
  });

  it('returns fallback when proxy headers are not trusted', () => {
    process.env['TRUSTED_PROXY'] = 'none';
    // Given
    const headers = new Headers({
      'cf-connecting-ip': '203.0.113.10',
      'x-forwarded-for': '203.0.113.11',
      'x-real-ip': '203.0.113.12',
    });

    // When
    const ip = getRequestIp(LOCAL_RUNTIME_PROFILE, headers, '198.51.100.1');

    // Then
    expect(ip).toBe('198.51.100.1');
  });
});
