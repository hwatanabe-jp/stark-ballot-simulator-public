import { describe, expect, it } from 'vitest';
import { isProductionRuntimeEnv, resolveRuntimeEnvMode } from '@stark-ballot/runtime-config/env/runtimeMode';
import { localRuntimeProfile, targetRuntimeProfile } from './__tests__/runtimeProfileFixtures';

describe('isProductionRuntimeEnv', () => {
  it('treats the protected main target profile as production', () => {
    expect(isProductionRuntimeEnv(targetRuntimeProfile('main'))).toBe(true);
  });

  it('treats the develop target profile as non-production', () => {
    expect(isProductionRuntimeEnv(targetRuntimeProfile('develop'))).toBe(false);
  });

  it('classifies local demo and static E2E profiles as non-production', () => {
    expect(isProductionRuntimeEnv(localRuntimeProfile('local-demo'))).toBe(false);
    expect(isProductionRuntimeEnv(localRuntimeProfile('static-mock-e2e'))).toBe(false);
  });

  it('does not confuse production proof evidence with target production deployment', () => {
    expect(resolveRuntimeEnvMode(localRuntimeProfile('local-proof-production'))).toBe('non-production');
  });

  it('uses the admitted target deployment environment without Lambda-name fallback', () => {
    expect(isProductionRuntimeEnv(targetRuntimeProfile('develop'))).toBe(false);
    expect(isProductionRuntimeEnv(targetRuntimeProfile('main'))).toBe(true);
  });

  it.each(['local-demo', 'static-mock-e2e', 'local-proof-development', 'local-proof-production'] as const)(
    'classifies the explicit local profile without environment marker heuristics: %s',
    (profileName) => {
      expect(resolveRuntimeEnvMode(localRuntimeProfile(profileName))).toBe('non-production');
    },
  );

  it.each(['local-demo', 'local-proof-development'] as const)(
    'does not require fallback markers for explicit profile %s',
    (profileName) => {
      expect(resolveRuntimeEnvMode(localRuntimeProfile(profileName))).toBe('non-production');
    },
  );

  it('does not infer target deployment from unrelated runtime environment markers', () => {
    expect(resolveRuntimeEnvMode(localRuntimeProfile())).toBe('non-production');
  });

  it('prefers the injected target deployment authority', () => {
    expect(resolveRuntimeEnvMode(targetRuntimeProfile('develop'))).toBe('non-production');
  });

  it('keeps local development-proof execution distinct from target deployment tier', () => {
    expect(resolveRuntimeEnvMode(localRuntimeProfile('local-proof-development'))).toBe('non-production');
  });
});

describe('resolveRuntimeEnvMode', () => {
  it('returns a known mode for the admitted local profile', () => {
    expect(resolveRuntimeEnvMode(localRuntimeProfile())).toBe('non-production');
  });

  it('returns a known mode for the admitted target profile', () => {
    expect(resolveRuntimeEnvMode(targetRuntimeProfile('main'))).toBe('production');
  });
});
