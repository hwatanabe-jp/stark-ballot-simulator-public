import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSessionCapabilityToken,
  resolveSessionCapabilitySecret,
  resolveSessionCapabilityTtlSeconds,
  verifySessionCapabilityToken,
} from './sessionCapabilityToken';

const TEST_SECRET = 'test-session-capability-secret-0123456789abcdef';
const AMPLIFY_RUNTIME_SECRET_PLACEHOLDER = '<value will be resolved during runtime>';

describe('sessionCapabilityToken', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
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
    delete process.env.SESSION_CAPABILITY_SECRET;

    expect(() => resolveSessionCapabilitySecret()).toThrow(
      'SESSION_CAPABILITY_SECRET must be set to at least 32 characters',
    );
  });

  it('throws when secret is unset outside test environment', () => {
    vi.stubEnv('NODE_ENV', 'development');
    delete process.env.SESSION_CAPABILITY_SECRET;

    expect(() => resolveSessionCapabilitySecret()).toThrow(
      'SESSION_CAPABILITY_SECRET must be set to at least 32 characters',
    );
  });

  it('throws when secret is unresolved Amplify placeholder', () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.SESSION_CAPABILITY_SECRET = AMPLIFY_RUNTIME_SECRET_PLACEHOLDER;

    expect(() => resolveSessionCapabilitySecret()).toThrow(
      'SESSION_CAPABILITY_SECRET was not resolved from Amplify Secrets',
    );
  });

  it('falls back to default ttl when configured value is invalid', () => {
    process.env.SESSION_CAPABILITY_TTL_SECONDS = 'abc';
    expect(resolveSessionCapabilityTtlSeconds()).toBe(24 * 60 * 60);
  });

  it('falls back to default ttl when configured value is non-integer', () => {
    process.env.SESSION_CAPABILITY_TTL_SECONDS = '0.5';
    expect(resolveSessionCapabilityTtlSeconds()).toBe(24 * 60 * 60);
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
