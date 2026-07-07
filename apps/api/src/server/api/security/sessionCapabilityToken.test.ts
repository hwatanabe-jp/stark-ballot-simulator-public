import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSessionCapabilityToken,
  DEFAULT_SESSION_CAPABILITY_TTL_SECONDS,
  MAX_SESSION_CAPABILITY_TTL_SECONDS,
  verifySessionCapabilityToken,
} from '@stark-ballot/domain/security/sessionCapabilityToken';
import { resolveSessionCapabilitySecret, resolveSessionCapabilityTtlSeconds } from './sessionCapabilityRuntimeConfig';
import {
  clearRuntimeConfigReferenceResolver,
  installStaticRuntimeConfigReferenceResolver,
} from '@stark-ballot/runtime-config/env/runtimeConfigReferences';

const TEST_SECRET = 'test-session-capability-secret-0123456789abcdef';
const RESOLVED_SESSION_SECRET = 'resolved-session-capability-secret-0123456789abcdef';
const UNRESOLVED_RUNTIME_SECRET_PLACEHOLDER = '<value will be resolved during runtime>';
const SESSION_SECRET_REF = '/stark-ballot-simulator/stark-dev/develop/app/secrets/session-capability-secret';
const SESSION_TTL_REF = '/stark-ballot-simulator/stark-dev/develop/app/config/session-capability-ttl-seconds';

describe('sessionCapabilityToken', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    delete process.env['USE_MOCK_STORE'];
    delete process.env['SESSION_CAPABILITY_SECRET_REF'];
    delete process.env['SESSION_CAPABILITY_TTL_SECONDS_REF'];
    clearRuntimeConfigReferenceResolver();
  });

  it('creates and verifies a valid token', () => {
    const token = createSessionCapabilityToken(
      {
        sessionId: 'session-123',
        nowMs: 1_700_000_000_000,
        ttlSeconds: 300,
        nonce: 'abc123',
      },
      TEST_SECRET,
    );

    const result = verifySessionCapabilityToken(token, TEST_SECRET, {
      sessionId: 'session-123',
      nowMs: 1_700_000_100_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessionId).toBe('session-123');
      expect(result.payload.nonce).toBe('abc123');
    }
  });

  it('rejects token for a different session id', () => {
    const token = createSessionCapabilityToken(
      {
        sessionId: 'session-a',
        nowMs: 1_700_000_000_000,
        ttlSeconds: 60,
      },
      TEST_SECRET,
    );

    const result = verifySessionCapabilityToken(token, TEST_SECRET, {
      sessionId: 'session-b',
      nowMs: 1_700_000_010_000,
    });

    expect(result).toEqual({ ok: false, reason: 'session_mismatch' });
  });

  it('rejects expired token', () => {
    const token = createSessionCapabilityToken(
      {
        sessionId: 'session-expired',
        nowMs: 1_700_000_000_000,
        ttlSeconds: 30,
      },
      TEST_SECRET,
    );

    const result = verifySessionCapabilityToken(token, TEST_SECRET, {
      sessionId: 'session-expired',
      nowMs: 1_700_000_100_000,
    });

    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('treats token as expired when now equals exp', () => {
    const token = createSessionCapabilityToken(
      {
        sessionId: 'session-exp-eq',
        nowMs: 1_700_000_000_000,
        ttlSeconds: 30,
      },
      TEST_SECRET,
    );

    const result = verifySessionCapabilityToken(token, TEST_SECRET, {
      sessionId: 'session-exp-eq',
      nowMs: 1_700_000_030_000,
    });

    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects tampered token', () => {
    const token = createSessionCapabilityToken(
      {
        sessionId: 'session-tampered',
        nowMs: 1_700_000_000_000,
        ttlSeconds: 60,
      },
      TEST_SECRET,
    );
    const tampered = `${token}a`;

    const result = verifySessionCapabilityToken(tampered, TEST_SECRET, {
      sessionId: 'session-tampered',
      nowMs: 1_700_000_010_000,
    });

    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('throws when secret is unset in test environment', () => {
    vi.stubEnv('NODE_ENV', 'test');
    delete process.env['SESSION_CAPABILITY_SECRET'];

    expect(() => resolveSessionCapabilitySecret()).toThrow(
      'SESSION_CAPABILITY_SECRET must be set to at least 32 characters',
    );
  });

  it('throws when secret is unset outside test environment', () => {
    vi.stubEnv('NODE_ENV', 'development');
    delete process.env['SESSION_CAPABILITY_SECRET'];

    expect(() => resolveSessionCapabilitySecret()).toThrow(
      'SESSION_CAPABILITY_SECRET must be set to at least 32 characters',
    );
  });

  it('throws when secret is unresolved runtime secret placeholder', () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env['SESSION_CAPABILITY_SECRET'] = UNRESOLVED_RUNTIME_SECRET_PLACEHOLDER;

    expect(() => resolveSessionCapabilitySecret()).toThrow(
      'SESSION_CAPABILITY_SECRET was not resolved from runtime secret references',
    );
  });

  it.each([
    SESSION_SECRET_REF,
    'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:/stark-ballot-simulator/stark-dev/develop/app/secrets/session-capability-secret-a1B2c3',
  ])('throws when raw session capability secret contains a reference: %s', (secretReference) => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env['SESSION_CAPABILITY_SECRET'] = secretReference;
    process.env['SESSION_CAPABILITY_SECRET_REF'] = SESSION_SECRET_REF;
    installStaticRuntimeConfigReferenceResolver(new Map([[SESSION_SECRET_REF, RESOLVED_SESSION_SECRET]]));

    expect(() => resolveSessionCapabilitySecret()).toThrow(
      'SESSION_CAPABILITY_SECRET must contain raw secret material, not a reference',
    );
  });

  it('resolves session capability secret from a target reference resolver', () => {
    vi.stubEnv('NODE_ENV', 'development');
    delete process.env['SESSION_CAPABILITY_SECRET'];
    process.env['SESSION_CAPABILITY_SECRET_REF'] = SESSION_SECRET_REF;
    installStaticRuntimeConfigReferenceResolver(new Map([[SESSION_SECRET_REF, RESOLVED_SESSION_SECRET]]));

    expect(resolveSessionCapabilitySecret()).toBe(RESOLVED_SESSION_SECRET);
  });

  it('rejects raw session capability secrets in target non-mock runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env['USE_MOCK_STORE'] = 'false';
    process.env['SESSION_CAPABILITY_SECRET'] = TEST_SECRET;
    process.env['SESSION_CAPABILITY_SECRET_REF'] = SESSION_SECRET_REF;
    installStaticRuntimeConfigReferenceResolver(new Map([[SESSION_SECRET_REF, RESOLVED_SESSION_SECRET]]));

    expect(() => resolveSessionCapabilitySecret()).toThrow(
      'SESSION_CAPABILITY_SECRET must not be set directly when USE_MOCK_STORE=false; use SESSION_CAPABILITY_SECRET_REF',
    );
  });

  it('fails closed when the session capability secret reference is unresolved', () => {
    vi.stubEnv('NODE_ENV', 'development');
    delete process.env['SESSION_CAPABILITY_SECRET'];
    process.env['SESSION_CAPABILITY_SECRET_REF'] = SESSION_SECRET_REF;

    expect(() => resolveSessionCapabilitySecret()).toThrow(
      'SESSION_CAPABILITY_SECRET_REF is configured but no target runtime resolver returned a value',
    );
  });

  it('uses the default ttl when the configured value is unset', () => {
    delete process.env['SESSION_CAPABILITY_TTL_SECONDS'];

    expect(resolveSessionCapabilityTtlSeconds()).toBe(DEFAULT_SESSION_CAPABILITY_TTL_SECONDS);
  });

  it('resolves session capability ttl from a target reference resolver', () => {
    delete process.env['SESSION_CAPABILITY_TTL_SECONDS'];
    process.env['SESSION_CAPABILITY_TTL_SECONDS_REF'] = SESSION_TTL_REF;
    installStaticRuntimeConfigReferenceResolver(new Map([[SESSION_TTL_REF, '3600']]));

    expect(resolveSessionCapabilityTtlSeconds()).toBe(3600);
  });

  it('rejects raw session capability ttl in target non-mock runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env['USE_MOCK_STORE'] = 'false';
    process.env['SESSION_CAPABILITY_TTL_SECONDS'] = '3600';
    process.env['SESSION_CAPABILITY_TTL_SECONDS_REF'] = SESSION_TTL_REF;
    installStaticRuntimeConfigReferenceResolver(new Map([[SESSION_TTL_REF, '120']]));

    expect(() => resolveSessionCapabilityTtlSeconds()).toThrow(
      'SESSION_CAPABILITY_TTL_SECONDS must not be set directly when USE_MOCK_STORE=false; use SESSION_CAPABILITY_TTL_SECONDS_REF',
    );
  });

  it('fails closed when the session capability ttl reference resolves to an invalid value', () => {
    delete process.env['SESSION_CAPABILITY_TTL_SECONDS'];
    process.env['SESSION_CAPABILITY_TTL_SECONDS_REF'] = SESSION_TTL_REF;
    installStaticRuntimeConfigReferenceResolver(new Map([[SESSION_TTL_REF, 'not-a-number']]));

    expect(() => resolveSessionCapabilityTtlSeconds()).toThrow(
      'Invalid SESSION_CAPABILITY_TTL_SECONDS value: not-a-number. Expected a positive integer.',
    );
  });

  it('throws when configured ttl is invalid', () => {
    process.env['SESSION_CAPABILITY_TTL_SECONDS'] = 'abc';
    expect(() => resolveSessionCapabilityTtlSeconds()).toThrow(
      'Invalid SESSION_CAPABILITY_TTL_SECONDS value: abc. Expected a positive integer.',
    );
  });

  it('throws when configured ttl is non-integer', () => {
    process.env['SESSION_CAPABILITY_TTL_SECONDS'] = '0.5';
    expect(() => resolveSessionCapabilityTtlSeconds()).toThrow(
      'Invalid SESSION_CAPABILITY_TTL_SECONDS value: 0.5. Expected a positive integer.',
    );
  });

  it('throws when configured ttl is zero', () => {
    process.env['SESSION_CAPABILITY_TTL_SECONDS'] = '0';
    expect(() => resolveSessionCapabilityTtlSeconds()).toThrow(
      'Invalid SESSION_CAPABILITY_TTL_SECONDS value: 0. Expected a positive integer.',
    );
  });

  it('throws when configured ttl is negative', () => {
    process.env['SESSION_CAPABILITY_TTL_SECONDS'] = '-1';
    expect(() => resolveSessionCapabilityTtlSeconds()).toThrow(
      'Invalid SESSION_CAPABILITY_TTL_SECONDS value: -1. Expected a positive integer.',
    );
  });

  it('throws when configured ttl is above the accepted maximum', () => {
    process.env['SESSION_CAPABILITY_TTL_SECONDS'] = String(MAX_SESSION_CAPABILITY_TTL_SECONDS + 1);
    expect(() => resolveSessionCapabilityTtlSeconds()).toThrow(
      `SESSION_CAPABILITY_TTL_SECONDS must be ${MAX_SESSION_CAPABILITY_TTL_SECONDS} or less.`,
    );
  });

  it('uses a valid configured ttl', () => {
    process.env['SESSION_CAPABILITY_TTL_SECONDS'] = '3600';
    expect(resolveSessionCapabilityTtlSeconds()).toBe(3600);
  });

  it('ignores non-integer ttl option when creating token', () => {
    const token = createSessionCapabilityToken(
      {
        sessionId: 'session-non-int-ttl',
        nowMs: 1_700_000_000_000,
        ttlSeconds: 0.5,
      },
      TEST_SECRET,
    );

    const result = verifySessionCapabilityToken(token, TEST_SECRET, {
      sessionId: 'session-non-int-ttl',
      nowMs: 1_700_000_001_000,
    });

    expect(result.ok).toBe(true);
  });
});
