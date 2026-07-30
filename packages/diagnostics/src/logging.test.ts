import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hashIpForLogging,
  hashKeyPrefixForLogging,
  hashSessionIdForLogging,
  isPublicDefaultLogSalt,
  resolveLogSalt,
} from './logging';

describe('logging salt resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses LOG_IP_HASH_SALT from the runtime environment when no explicit salt is supplied', () => {
    vi.stubEnv('LOG_IP_HASH_SALT', 'target-runtime-log-salt');

    expect(resolveLogSalt()).toBe('target-runtime-log-salt');
    expect(hashIpForLogging('203.0.113.9')).toBe(hashIpForLogging('203.0.113.9', 'target-runtime-log-salt'));
  });

  it('uses stable domain-separated hashes for session IDs, IPs, and S3 key prefixes', () => {
    const salt = 'test-salt';

    expect(hashSessionIdForLogging('550e8400-e29b-41d4-a716-446655440000', salt)).toBe('sid_009d9486a2f2');
    expect(hashIpForLogging('203.0.113.9', salt)).toBe('ip_39244dfb55c1');
    expect(hashKeyPrefixForLogging('Sessions/CaseSensitive/Bundle.zip', salt)).toBe('key_f74c4416de9c');
  });

  it('does not correlate the same value across identifier domains', () => {
    const value = 'same-value';
    const salt = 'test-salt';

    expect(
      new Set([
        hashSessionIdForLogging(value, salt),
        hashIpForLogging(value, salt),
        hashKeyPrefixForLogging(value, salt),
      ]).size,
    ).toBe(3);
  });

  it('preserves S3 key case while normalizing session IDs and IPs', () => {
    const salt = 'test-salt';

    expect(hashKeyPrefixForLogging('Sessions/CaseSensitive/Bundle.zip', salt)).not.toBe(
      hashKeyPrefixForLogging('sessions/casesensitive/bundle.zip', salt),
    );
    expect(hashSessionIdForLogging(' SESSION-ID ', salt)).toBe(hashSessionIdForLogging('session-id', salt));
    expect(hashIpForLogging(' 2001:DB8::1 ', salt)).toBe(hashIpForLogging('2001:db8::1', salt));
  });

  it('falls through a blank explicit salt to the configured environment salt', () => {
    vi.stubEnv('LOG_IP_HASH_SALT', 'target-runtime-log-salt');

    expect(resolveLogSalt('   ')).toBe('target-runtime-log-salt');
  });

  it('identifies the public local-development salt', () => {
    expect(isPublicDefaultLogSalt('stark-ballot-log-salt')).toBe(true);
    expect(isPublicDefaultLogSalt(' target-runtime-log-salt ')).toBe(false);
    expect(isPublicDefaultLogSalt(undefined)).toBe(false);
  });
});
