/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { secret } from '@aws-amplify/backend';
import { addFunctionEnvironments, resolveSecretBackedEnv } from '../lib/function-environment';

vi.mock('@aws-amplify/backend', () => ({
  secret: vi.fn((name: string) => ({ __secretName: name })),
}));

describe('resolveSecretBackedEnv', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SESSION_CAPABILITY_SECRET;
    delete process.env.TURNSTILE_SECRET_KEY;
  });

  it('always returns Amplify secret reference even when process env has a value', () => {
    process.env.SESSION_CAPABILITY_SECRET = 'legacy-plain-env-value';
    const value = resolveSecretBackedEnv('SESSION_CAPABILITY_SECRET', { required: true });

    expect(secret).toHaveBeenCalledWith('SESSION_CAPABILITY_SECRET');
    expect(value).toEqual({ __secretName: 'SESSION_CAPABILITY_SECRET' });
  });

  it('returns Amplify secret reference when required value is missing', () => {
    const value = resolveSecretBackedEnv('SESSION_CAPABILITY_SECRET', { required: true });

    expect(secret).toHaveBeenCalledWith('SESSION_CAPABILITY_SECRET');
    expect(value).toEqual({ __secretName: 'SESSION_CAPABILITY_SECRET' });
  });

  it('returns undefined when optional value is missing', () => {
    const value = resolveSecretBackedEnv('TURNSTILE_SECRET_KEY', { required: false });

    expect(value).toBeUndefined();
    expect(secret).not.toHaveBeenCalled();
  });
});

describe('addFunctionEnvironments', () => {
  it('adds string and secret values and skips empty/undefined values', () => {
    const target = {
      addEnvironment: vi.fn(),
    };
    const secretRef = { __secretName: 'SESSION_CAPABILITY_SECRET' } as ReturnType<typeof secret>;

    addFunctionEnvironments(target, {
      PLAIN: 'plain-value',
      EMPTY: '',
      OPTIONAL: undefined,
      SECRET: secretRef,
    });

    expect(target.addEnvironment).toHaveBeenCalledTimes(2);
    expect(target.addEnvironment).toHaveBeenNthCalledWith(1, 'PLAIN', 'plain-value');
    expect(target.addEnvironment).toHaveBeenNthCalledWith(2, 'SECRET', secretRef);
  });
});
