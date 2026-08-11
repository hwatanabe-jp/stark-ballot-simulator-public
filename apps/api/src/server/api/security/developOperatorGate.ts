import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

export const ORIGIN_VERIFY_HEADER = 'X-Stark-Ballot-Origin-Verify';

export function isExpectedTargetOriginVerified(profile: ResolvedRuntimeProfile, request: Request): boolean {
  if (profile.target.kind !== 'aws') {
    return false;
  }

  const expected = process.env['EXPECTED_ORIGIN_VERIFY_HEADER']?.trim();
  if (!expected) {
    return false;
  }

  return request.headers.get(ORIGIN_VERIFY_HEADER)?.trim() === expected;
}

export function isOperatorGatedDevelopRequest(profile: ResolvedRuntimeProfile, request: Request): boolean {
  return (
    profile.target.kind === 'aws' &&
    profile.target.deploymentEnvironment === 'develop' &&
    profile.turnstile.mode === 'operator-gated' &&
    isExpectedTargetOriginVerified(profile, request)
  );
}
