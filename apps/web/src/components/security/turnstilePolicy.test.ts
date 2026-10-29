import { afterEach, describe, expect, it } from 'vitest';
import {
  clearPublicRuntimeEnvForTests,
  setPublicRuntimeEnvForTests,
} from '@stark-ballot/runtime-config/env/public-runtime-config';
import { isBrowserTurnstileRequiredForAction, type TurnstileAction } from './turnstilePolicy';

const ACTIONS: readonly TurnstileAction[] = ['session', 'vote', 'finalize'];

describe('isBrowserTurnstileRequiredForAction', () => {
  afterEach(() => {
    clearPublicRuntimeEnvForTests();
  });

  it('requires Turnstile for every browser action in target main', () => {
    setPublicRuntimeEnvForTests('VITE_RUNTIME_PROFILE', 'target-aws-async');
    setPublicRuntimeEnvForTests('VITE_APP_ENV', 'main');

    for (const action of ACTIONS) {
      expect(isBrowserTurnstileRequiredForAction(action)).toBe(true);
    }
  });

  it('relaxes Turnstile for every browser action in operator-gated target develop', () => {
    setPublicRuntimeEnvForTests('VITE_RUNTIME_PROFILE', 'target-aws-async');
    setPublicRuntimeEnvForTests('VITE_APP_ENV', 'develop');

    for (const action of ACTIONS) {
      expect(isBrowserTurnstileRequiredForAction(action)).toBe(false);
    }
  });

  it.each(['local-demo', 'static-mock-e2e', 'local-proof-development', 'local-proof-production'] as const)(
    'relaxes Turnstile for every browser action in %s',
    (profile) => {
      setPublicRuntimeEnvForTests('VITE_RUNTIME_PROFILE', profile);

      for (const action of ACTIONS) {
        expect(isBrowserTurnstileRequiredForAction(action)).toBe(false);
      }
    },
  );
});
