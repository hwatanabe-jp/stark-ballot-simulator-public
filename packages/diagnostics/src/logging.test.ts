import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashIpForLogging, resolveLogSalt } from './logging';

describe('logging salt resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses LOG_IP_HASH_SALT from the runtime environment when no explicit salt is supplied', () => {
    vi.stubEnv('LOG_IP_HASH_SALT', 'target-runtime-log-salt');

    expect(resolveLogSalt()).toBe('target-runtime-log-salt');
    expect(hashIpForLogging('203.0.113.9')).toBe(hashIpForLogging('203.0.113.9', 'target-runtime-log-salt'));
  });
});
