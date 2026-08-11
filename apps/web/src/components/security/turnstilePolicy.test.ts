import { afterEach, describe, expect, it } from 'vitest';
import {
  clearBrowserPublicEnvForTests,
  setBrowserPublicEnvForTests,
} from '@stark-ballot/runtime-config/env/browserPublic';
import { isBrowserTurnstileRequiredForAction, type TurnstileAction } from './turnstilePolicy';

const ACTIONS: readonly TurnstileAction[] = ['session', 'vote', 'finalize'];

describe('isBrowserTurnstileRequiredForAction', () => {
  afterEach(() => {
    clearBrowserPublicEnvForTests();
  });

  it('requires Turnstile for every browser action in target main', () => {
    setBrowserPublicEnvForTests('VITE_RUNTIME_PROFILE', 'target-aws-async');
    setBrowserPublicEnvForTests('VITE_APP_ENV', 'main');

    for (const action of ACTIONS) {
      expect(isBrowserTurnstileRequiredForAction(action)).toBe(true);
    }
  });

  it('relaxes Turnstile for every browser action in operator-gated target develop', () => {
    setBrowserPublicEnvForTests('VITE_RUNTIME_PROFILE', 'target-aws-async');
    setBrowserPublicEnvForTests('VITE_APP_ENV', 'develop');

    for (const action of ACTIONS) {
      expect(isBrowserTurnstileRequiredForAction(action)).toBe(false);
    }
  });

  it.each(['local-demo', 'static-mock-e2e', 'local-proof-development', 'local-proof-production'] as const)(
    'relaxes Turnstile for every browser action in %s',
    (profile) => {
      setBrowserPublicEnvForTests('VITE_RUNTIME_PROFILE', profile);

      for (const action of ACTIONS) {
        expect(isBrowserTurnstileRequiredForAction(action)).toBe(false);
      }
    },
  );
});
