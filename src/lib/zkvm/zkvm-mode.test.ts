import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { assertZkvmModeAllowed, resolveZkvmMode, INSECURE_ZKVM_MODE_MESSAGE } from '@/lib/zkvm/zkvm-mode';

const originalEnv = { ...process.env };

const restoreEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
};

describe('zkvm-mode safety checks', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    restoreEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    restoreEnv();
  });

  it('blocks mock zkVM mode in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.USE_MOCK_ZKVM = 'true';

    const mode = resolveZkvmMode();
    expect(() => assertZkvmModeAllowed(mode)).toThrow(INSECURE_ZKVM_MODE_MESSAGE);
  });

  it('blocks dev zkVM mode in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.RISC0_DEV_MODE = '1';

    const mode = resolveZkvmMode();
    expect(() => assertZkvmModeAllowed(mode)).toThrow(INSECURE_ZKVM_MODE_MESSAGE);
  });

  it('allows insecure modes in production when override is set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOW_INSECURE_ZKVM', 'true');
    process.env.USE_MOCK_ZKVM = 'true';

    const mode = resolveZkvmMode();
    expect(() => assertZkvmModeAllowed(mode)).not.toThrow();
  });

  it('allows insecure modes outside production', () => {
    vi.stubEnv('NODE_ENV', 'test');
    process.env.USE_MOCK_ZKVM = 'true';

    const mode = resolveZkvmMode();
    expect(() => assertZkvmModeAllowed(mode)).not.toThrow();
  });
});
