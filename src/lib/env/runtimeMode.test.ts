import { describe, expect, it } from 'vitest';
import { isProductionRuntimeEnv, resolveRuntimeEnvMode } from '@/lib/env/runtimeMode';

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides };
}

describe('isProductionRuntimeEnv', () => {
  it('treats main branch as production', () => {
    expect(isProductionRuntimeEnv(env({ AWS_BRANCH: 'main' }))).toBe(true);
  });

  it('treats develop branch as non-production even when NODE_ENV is production', () => {
    expect(isProductionRuntimeEnv(env({ NODE_ENV: 'production', AWS_BRANCH: 'develop' }))).toBe(false);
  });

  it('falls back to ENV_NAME when branch markers are missing', () => {
    expect(
      isProductionRuntimeEnv(
        env({
          AWS_BRANCH: undefined,
          AMPLIFY_BRANCH: undefined,
          RUNTIME_DEPLOYMENT_ENV: undefined,
          AWS_LAMBDA_FUNCTION_NAME: undefined,
          ENV_NAME: 'production',
        }),
      ),
    ).toBe(true);
    expect(
      isProductionRuntimeEnv(
        env({
          AWS_BRANCH: undefined,
          AMPLIFY_BRANCH: undefined,
          RUNTIME_DEPLOYMENT_ENV: undefined,
          AWS_LAMBDA_FUNCTION_NAME: undefined,
          ENV_NAME: 'develop',
        }),
      ),
    ).toBe(false);
  });

  it('uses Lambda function name as fallback when branch markers are missing', () => {
    expect(
      isProductionRuntimeEnv(
        env({
          AWS_BRANCH: undefined,
          AMPLIFY_BRANCH: undefined,
          RUNTIME_DEPLOYMENT_ENV: undefined,
          ENV_NAME: 'production',
          AWS_LAMBDA_FUNCTION_NAME: 'amplify-exampleapp-devel-honoapilambda-test',
        }),
      ),
    ).toBe(false);

    expect(
      isProductionRuntimeEnv(
        env({
          AWS_BRANCH: undefined,
          AMPLIFY_BRANCH: undefined,
          RUNTIME_DEPLOYMENT_ENV: undefined,
          ENV_NAME: 'develop',
          AWS_LAMBDA_FUNCTION_NAME: 'amplify-exampleapp-main-honoapilambda-test',
        }),
      ),
    ).toBe(true);
  });
});

describe('resolveRuntimeEnvMode', () => {
  it('returns unknown when deployment markers are missing', () => {
    expect(
      resolveRuntimeEnvMode(
        env({
          AWS_BRANCH: undefined,
          AMPLIFY_BRANCH: undefined,
          RUNTIME_DEPLOYMENT_ENV: undefined,
          AWS_LAMBDA_FUNCTION_NAME: undefined,
          ENV_NAME: undefined,
        }),
      ),
    ).toBe('unknown');
  });

  it('returns unknown for unsupported marker values', () => {
    expect(
      resolveRuntimeEnvMode(
        env({
          AWS_BRANCH: 'staging',
          AMPLIFY_BRANCH: 'qa',
          RUNTIME_DEPLOYMENT_ENV: 'preview',
          AWS_LAMBDA_FUNCTION_NAME: 'custom-runtime-handler',
          ENV_NAME: 'sandbox',
        }),
      ),
    ).toBe('unknown');
  });
});
