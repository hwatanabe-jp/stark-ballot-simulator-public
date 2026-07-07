import { afterEach, describe, expect, it, vi } from 'vitest';

import { isOperatorGatedDevelopRequest, ORIGIN_VERIFY_HEADER } from './developOperatorGate';

const originVerifyHeader = 'origin-header-secret-0123456789abcdef';
const envKeys = [
  'TARGET_AWS_RUNTIME',
  'EXPECTED_ORIGIN_VERIFY_HEADER',
  'RUNTIME_DEPLOYMENT_ENV',
  'TARGET_DEVELOP_OPERATOR_GATE_ENABLED',
] as const;

function restoreEnv(original: Record<(typeof envKeys)[number], string | undefined>): void {
  for (const key of envKeys) {
    const value = original[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function targetDevelopRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://develop.example/api/vote', {
    method: 'POST',
    headers,
  });
}

describe('isOperatorGatedDevelopRequest', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts only target develop requests admitted through the expected origin-verify header', () => {
    vi.stubEnv('TARGET_AWS_RUNTIME', '1');
    vi.stubEnv('EXPECTED_ORIGIN_VERIFY_HEADER', originVerifyHeader);
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', 'develop');
    vi.stubEnv('TARGET_DEVELOP_OPERATOR_GATE_ENABLED', 'true');

    expect(isOperatorGatedDevelopRequest(targetDevelopRequest({ [ORIGIN_VERIFY_HEADER]: originVerifyHeader }))).toBe(
      true,
    );
  });

  it('rejects the exception outside develop or without the verified CloudFront origin path', () => {
    const original = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<
      (typeof envKeys)[number],
      string | undefined
    >;

    try {
      process.env['TARGET_AWS_RUNTIME'] = '1';
      process.env['EXPECTED_ORIGIN_VERIFY_HEADER'] = originVerifyHeader;
      process.env['RUNTIME_DEPLOYMENT_ENV'] = 'develop';
      process.env['TARGET_DEVELOP_OPERATOR_GATE_ENABLED'] = 'true';

      expect(isOperatorGatedDevelopRequest(targetDevelopRequest())).toBe(false);
      expect(isOperatorGatedDevelopRequest(targetDevelopRequest({ [ORIGIN_VERIFY_HEADER]: 'wrong' }))).toBe(false);

      process.env['RUNTIME_DEPLOYMENT_ENV'] = 'main';
      expect(isOperatorGatedDevelopRequest(targetDevelopRequest({ [ORIGIN_VERIFY_HEADER]: originVerifyHeader }))).toBe(
        false,
      );

      process.env['RUNTIME_DEPLOYMENT_ENV'] = 'develop';
      process.env['TARGET_DEVELOP_OPERATOR_GATE_ENABLED'] = 'false';
      expect(isOperatorGatedDevelopRequest(targetDevelopRequest({ [ORIGIN_VERIFY_HEADER]: originVerifyHeader }))).toBe(
        false,
      );

      process.env['TARGET_AWS_RUNTIME'] = '0';
      process.env['TARGET_DEVELOP_OPERATOR_GATE_ENABLED'] = 'true';
      expect(isOperatorGatedDevelopRequest(targetDevelopRequest({ [ORIGIN_VERIFY_HEADER]: originVerifyHeader }))).toBe(
        false,
      );
    } finally {
      restoreEnv(original);
    }
  });
});
