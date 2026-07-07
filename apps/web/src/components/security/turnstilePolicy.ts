import { readBrowserPublicFlag } from '@stark-ballot/runtime-config/env/browserPublic';

export type TurnstileAction = 'session' | 'vote' | 'finalize';

const TURNSTILE_REQUIRED_FLAG_BY_ACTION: Record<TurnstileAction, 'VITE_SESSION_CREATE_TURNSTILE_REQUIRED'> = {
  session: 'VITE_SESSION_CREATE_TURNSTILE_REQUIRED',
  vote: 'VITE_SESSION_CREATE_TURNSTILE_REQUIRED',
  finalize: 'VITE_SESSION_CREATE_TURNSTILE_REQUIRED',
};

export function isBrowserTurnstileRequiredForAction(action: TurnstileAction): boolean {
  return readBrowserPublicFlag(TURNSTILE_REQUIRED_FLAG_BY_ACTION[action]);
}
