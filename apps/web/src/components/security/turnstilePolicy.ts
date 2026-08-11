import { resolveBrowserRuntimeProfile } from '@stark-ballot/runtime-config/env/public-runtime-config';

export type TurnstileAction = 'session' | 'vote' | 'finalize';

export function isBrowserTurnstileRequiredForAction(action: TurnstileAction): boolean {
  void action;
  return resolveBrowserRuntimeProfile().turnstile.requiredForActions;
}
