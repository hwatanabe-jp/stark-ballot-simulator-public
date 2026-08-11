import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RuntimeConfigValidationError } from '@stark-ballot/runtime-config/env/configValidationError';
import {
  BROWSER_PUBLIC_ENV_KEYS,
  clearPublicRuntimeEnvForTests,
  resolveBrowserRuntimeProfile,
  setPublicRuntimeEnvForTests,
} from './public-runtime-config';

function setProfile(name: string, appEnvironment?: string): void {
  setPublicRuntimeEnvForTests('VITE_RUNTIME_PROFILE', name);
  if (appEnvironment) {
    setPublicRuntimeEnvForTests('VITE_APP_ENV', appEnvironment);
  }
}

function captureFailure(): RuntimeConfigValidationError {
  try {
    resolveBrowserRuntimeProfile();
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeConfigValidationError);
    return error as RuntimeConfigValidationError;
  }
  throw new Error('Expected browser runtime profile resolution to fail');
}

describe('resolveBrowserRuntimeProfile', () => {
  beforeEach(() => {
    for (const key of BROWSER_PUBLIC_ENV_KEYS) {
      setPublicRuntimeEnvForTests(key, undefined);
    }
  });

  afterEach(() => {
    clearPublicRuntimeEnvForTests();
  });

  it('exposes only the current browser-safe environment inputs', () => {
    expect(BROWSER_PUBLIC_ENV_KEYS).toEqual([
      'VITE_API_BASE_URL',
      'VITE_APP_ENV',
      'VITE_DEPLOYMENT_ID',
      'VITE_RUNTIME_PROFILE',
      'VITE_STH_MIN_MATCHES',
      'VITE_STH_SOURCES',
      'VITE_TURNSTILE_SITE_KEY',
    ]);
  });

  it.each([
    [
      'local-demo',
      {
        name: 'local-demo',
        apiMode: 'mock',
        turnstile: { bypassEligible: true, requiredForActions: false },
      },
    ],
    [
      'static-mock-e2e',
      {
        name: 'static-mock-e2e',
        apiMode: 'same-origin',
        turnstile: { bypassEligible: true, requiredForActions: false },
      },
    ],
    [
      'local-proof-development',
      {
        name: 'local-proof-development',
        apiMode: 'same-origin',
        turnstile: { bypassEligible: true, requiredForActions: false },
      },
    ],
    [
      'local-proof-production',
      {
        name: 'local-proof-production',
        apiMode: 'same-origin',
        turnstile: { bypassEligible: true, requiredForActions: false },
      },
    ],
  ] as const)('projects the %s browser policy', (name, expected) => {
    setProfile(name);

    expect(resolveBrowserRuntimeProfile()).toEqual(expected);
  });

  it.each([
    [
      'develop',
      {
        name: 'target-aws-async',
        appEnvironment: 'develop',
        apiMode: 'same-origin',
        turnstile: { bypassEligible: false, requiredForActions: false },
      },
    ],
    [
      'main',
      {
        name: 'target-aws-async',
        appEnvironment: 'main',
        apiMode: 'same-origin',
        turnstile: { bypassEligible: false, requiredForActions: true },
      },
    ],
  ] as const)('projects target %s browser admission', (appEnvironment, expected) => {
    setProfile('target-aws-async', appEnvironment);

    expect(resolveBrowserRuntimeProfile()).toEqual(expected);
  });

  it.each([undefined, '', 'local-mock', 'development', 'VITE_USE_MOCK_API'])(
    'rejects missing, unknown, or retired selector %s',
    (selector) => {
      if (selector !== undefined) {
        setProfile(selector);
      }

      expect(captureFailure().invalidNames).toEqual(['VITE_RUNTIME_PROFILE']);
    },
  );

  it.each([undefined, '', 'development', 'production'])(
    'rejects target profile with invalid app environment %s',
    (appEnvironment) => {
      setProfile('target-aws-async');
      if (appEnvironment !== undefined) {
        setPublicRuntimeEnvForTests('VITE_APP_ENV', appEnvironment);
      }

      expect(captureFailure().invalidNames).toEqual(['VITE_APP_ENV']);
    },
  );

  it('returns a deeply immutable projection', () => {
    setProfile('target-aws-async', 'main');

    const projection = resolveBrowserRuntimeProfile();

    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.turnstile)).toBe(true);
  });
});
