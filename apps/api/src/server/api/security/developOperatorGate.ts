import { isTruthyFlag } from '@stark-ballot/runtime-config/env/flags';

export const ORIGIN_VERIFY_HEADER = 'X-Stark-Ballot-Origin-Verify';

export function isExpectedTargetOriginVerified(request: Request): boolean {
  if (process.env['TARGET_AWS_RUNTIME'] !== '1') {
    return false;
  }

  const expected = process.env['EXPECTED_ORIGIN_VERIFY_HEADER']?.trim();
  if (!expected) {
    return false;
  }

  return request.headers.get(ORIGIN_VERIFY_HEADER)?.trim() === expected;
}

export function isOperatorGatedDevelopRequest(request: Request): boolean {
  return (
    process.env['TARGET_AWS_RUNTIME'] === '1' &&
    process.env['RUNTIME_DEPLOYMENT_ENV'] === 'develop' &&
    isTruthyFlag(process.env['TARGET_DEVELOP_OPERATOR_GATE_ENABLED']) &&
    isExpectedTargetOriginVerified(request)
  );
}
