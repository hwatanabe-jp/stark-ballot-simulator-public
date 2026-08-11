import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

export function isTargetAwsRuntime(profile: ResolvedRuntimeProfile): boolean {
  return profile.target.kind === 'aws';
}
