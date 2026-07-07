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

  it('requires Turnstile for every browser action when the target static config requires it', () => {
    setBrowserPublicEnvForTests('VITE_SESSION_CREATE_TURNSTILE_REQUIRED', 'true');

    for (const action of ACTIONS) {
      expect(isBrowserTurnstileRequiredForAction(action)).toBe(true);
    }
  });

  it('relaxes Turnstile for every browser action in operator-gated develop static config', () => {
    setBrowserPublicEnvForTests('VITE_SESSION_CREATE_TURNSTILE_REQUIRED', 'false');

    for (const action of ACTIONS) {
      expect(isBrowserTurnstileRequiredForAction(action)).toBe(false);
    }
  });
});
