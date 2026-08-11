import { describe, expect, it } from 'vitest';
import { isTargetAwsRuntime } from '@stark-ballot/runtime-config/env/targetRuntime';
import { localRuntimeProfile, targetRuntimeProfile } from './__tests__/runtimeProfileFixtures';

describe('isTargetAwsRuntime', () => {
  it('derives target selection only from the injected resolved profile', () => {
    expect(isTargetAwsRuntime(targetRuntimeProfile())).toBe(true);
    expect(isTargetAwsRuntime(localRuntimeProfile())).toBe(false);
  });
});
