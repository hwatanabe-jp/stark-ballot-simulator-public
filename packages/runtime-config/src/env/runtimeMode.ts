import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

export type RuntimeEnvMode = 'production' | 'non-production';

export function resolveRuntimeEnvMode(profile: ResolvedRuntimeProfile): RuntimeEnvMode {
  return profile.target.kind === 'aws' && profile.target.deploymentEnvironment === 'main'
    ? 'production'
    : 'non-production';
}

export function isProductionRuntimeEnv(profile: ResolvedRuntimeProfile): boolean {
  return resolveRuntimeEnvMode(profile) === 'production';
}
