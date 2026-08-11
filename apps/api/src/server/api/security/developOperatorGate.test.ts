import { afterEach, describe, expect, it, vi } from 'vitest';

import { isOperatorGatedDevelopRequest, ORIGIN_VERIFY_HEADER } from './developOperatorGate';
import {
  localRuntimeProfile,
  targetRuntimeProfile,
} from '@stark-ballot/runtime-config/env/__tests__/runtimeProfileFixtures';

const originVerifyHeader = 'origin-header-secret-0123456789abcdef';

function targetDevelopRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://develop.example/api/sessions/session-123/votes', {
    method: 'POST',
    headers,
  });
}

describe('isOperatorGatedDevelopRequest', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts only target develop requests admitted through the expected origin-verify header', () => {
    vi.stubEnv('EXPECTED_ORIGIN_VERIFY_HEADER', originVerifyHeader);

    expect(
      isOperatorGatedDevelopRequest(
        targetRuntimeProfile('develop'),
        targetDevelopRequest({ [ORIGIN_VERIFY_HEADER]: originVerifyHeader }),
      ),
    ).toBe(true);
  });

  it('does not grant target operator admission to an injected local profile', () => {
    vi.stubEnv('EXPECTED_ORIGIN_VERIFY_HEADER', originVerifyHeader);

    expect(
      isOperatorGatedDevelopRequest(
        localRuntimeProfile(),
        targetDevelopRequest({ [ORIGIN_VERIFY_HEADER]: originVerifyHeader }),
      ),
    ).toBe(false);
  });

  it('rejects the exception outside the develop profile or without the verified CloudFront origin path', () => {
    vi.stubEnv('EXPECTED_ORIGIN_VERIFY_HEADER', originVerifyHeader);
    const developProfile = targetRuntimeProfile('develop');

    expect(isOperatorGatedDevelopRequest(developProfile, targetDevelopRequest())).toBe(false);
    expect(
      isOperatorGatedDevelopRequest(developProfile, targetDevelopRequest({ [ORIGIN_VERIFY_HEADER]: 'wrong' })),
    ).toBe(false);
    expect(
      isOperatorGatedDevelopRequest(
        targetRuntimeProfile('main'),
        targetDevelopRequest({ [ORIGIN_VERIFY_HEADER]: originVerifyHeader }),
      ),
    ).toBe(false);
    expect(
      isOperatorGatedDevelopRequest(
        developProfile,
        targetDevelopRequest({ [ORIGIN_VERIFY_HEADER]: originVerifyHeader }),
      ),
    ).toBe(true);
  });
});
