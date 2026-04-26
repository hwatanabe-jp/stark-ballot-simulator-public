import { describe, it, expect } from 'vitest';
import { createDebugLogToken, verifyDebugLogToken } from './debugLogToken';

const secret = 'test-secret-32-characters-minimum-123456';

const nowMs = Date.UTC(2025, 0, 1, 0, 0, 0);
const nowSeconds = Math.floor(nowMs / 1000);

const createToken = (expiresAtSeconds: number): string =>
  createDebugLogToken({ expiresAt: expiresAtSeconds, level: 'debug' }, secret);

describe('debugLogToken', () => {
  it('verifies a valid token', () => {
    const token = createToken(nowSeconds + 60);
    const result = verifyDebugLogToken(token, secret, { now: nowMs });

    expect(result).toEqual({ expiresAt: nowSeconds + 60, level: 'debug' });
  });

  it('rejects expired tokens', () => {
    const token = createToken(nowSeconds - 1);
    const result = verifyDebugLogToken(token, secret, { now: nowMs });

    expect(result).toBeNull();
  });

  it('rejects tokens with invalid signatures', () => {
    const token = createToken(nowSeconds + 60);
    const result = verifyDebugLogToken(token, 'wrong-secret', { now: nowMs });

    expect(result).toBeNull();
  });

  it('rejects tokens beyond max TTL', () => {
    const token = createToken(nowSeconds + 3600);
    const result = verifyDebugLogToken(token, secret, { now: nowMs, maxTtlSeconds: 60 });

    expect(result).toBeNull();
  });

  it('rejects malformed tokens', () => {
    const result = verifyDebugLogToken('not-a-token', secret, { now: nowMs });

    expect(result).toBeNull();
  });
});
