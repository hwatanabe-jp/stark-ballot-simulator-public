import { resolveRuntimeProfile, type ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

type PlaywrightRuntimeProfile = Extract<ResolvedRuntimeProfile, { readonly target: { readonly kind: 'local' } }>;

function resolvePlaywrightRuntimeProfile(env: NodeJS.ProcessEnv = process.env): PlaywrightRuntimeProfile {
  const profile = resolveRuntimeProfile(env);
  if (
    profile.name !== 'static-mock-e2e' &&
    profile.name !== 'local-proof-development' &&
    profile.name !== 'local-proof-production'
  ) {
    throw new Error(`Runtime profile ${profile.name} is not supported by the Playwright production-build harness.`);
  }
  return profile;
}

export const PLAYWRIGHT_RUNTIME_PROFILE = resolvePlaywrightRuntimeProfile();
