import { describe, expect, it } from 'vitest';
import { isProductionRuntimeEnv, resolveRuntimeEnvMode } from '@stark-ballot/runtime-config/env/runtimeMode';

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RUNTIME_DEPLOYMENT_ENV: undefined,
    AWS_EXECUTION_ENV: undefined,
    AWS_LAMBDA_FUNCTION_NAME: undefined,
    ENV_NAME: undefined,
    ...overrides,
  };
}

describe('isProductionRuntimeEnv', () => {
  it('treats main branch as production', () => {
    expect(isProductionRuntimeEnv(env({ RUNTIME_DEPLOYMENT_ENV: 'main' }))).toBe(true);
  });

  it('treats develop branch as non-production even when NODE_ENV is production', () => {
    expect(isProductionRuntimeEnv(env({ NODE_ENV: 'production', RUNTIME_DEPLOYMENT_ENV: 'develop' }))).toBe(false);
  });

  it('falls back to ENV_NAME when branch markers are missing', () => {
    expect(
      isProductionRuntimeEnv(
        env({
          RUNTIME_DEPLOYMENT_ENV: undefined,
          AWS_EXECUTION_ENV: undefined,
          AWS_LAMBDA_FUNCTION_NAME: undefined,
          ENV_NAME: 'production',
        }),
      ),
    ).toBe(true);
    expect(
      isProductionRuntimeEnv(
        env({
          RUNTIME_DEPLOYMENT_ENV: undefined,
          AWS_EXECUTION_ENV: undefined,
          AWS_LAMBDA_FUNCTION_NAME: undefined,
          ENV_NAME: 'develop',
        }),
      ),
    ).toBe(false);
  });

  it('keeps ENV_NAME fallback for local AWS SDK config without AWS execution markers', () => {
    expect(
      resolveRuntimeEnvMode(
        env({
          RUNTIME_DEPLOYMENT_ENV: undefined,
          AWS_EXECUTION_ENV: undefined,
          AWS_LAMBDA_FUNCTION_NAME: undefined,
          AWS_REGION: 'ap-northeast-1',
          ENV_NAME: 'develop',
        }),
      ),
    ).toBe('non-production');
  });

  it('uses target Lambda function name as fallback when branch markers are missing', () => {
    expect(
      isProductionRuntimeEnv(
        env({
          RUNTIME_DEPLOYMENT_ENV: undefined,
          ENV_NAME: undefined,
          AWS_LAMBDA_FUNCTION_NAME: 'stark-ballot-simulator-stark-dev-develop-public-api',
        }),
      ),
    ).toBe(false);

    expect(
      isProductionRuntimeEnv(
        env({
          RUNTIME_DEPLOYMENT_ENV: undefined,
          ENV_NAME: undefined,
          AWS_LAMBDA_FUNCTION_NAME: 'stark-ballot-simulator-stark-prod-main-public-api',
        }),
      ),
    ).toBe(true);
  });

  it.each([
    'amplify-starkballotsimulator-dev-honoapi-lambda',
    'stark-ballot-simulator-dev-preview-public-api',
    'custom-prod-worker',
    'legacy-develop-finalization-writer',
    'stark-ballot-simulator-stark-dev-develop-image-signature-gate',
  ])('does not classify legacy or arbitrary Lambda function names: %s', (functionName) => {
    expect(
      resolveRuntimeEnvMode(
        env({
          RUNTIME_DEPLOYMENT_ENV: undefined,
          ENV_NAME: undefined,
          AWS_LAMBDA_FUNCTION_NAME: functionName,
        }),
      ),
    ).toBe('unknown');
  });

  it.each(['amplify-starkballotsimulator-dev-honoapi-lambda', 'stark-ballot-simulator-dev-preview-public-api'])(
    'does not fall back to ENV_NAME for untrusted AWS Lambda names: %s',
    (functionName) => {
      expect(
        resolveRuntimeEnvMode(
          env({
            RUNTIME_DEPLOYMENT_ENV: undefined,
            AWS_EXECUTION_ENV: undefined,
            AWS_LAMBDA_FUNCTION_NAME: functionName,
            ENV_NAME: 'develop',
          }),
        ),
      ).toBe('unknown');
    },
  );

  it('does not fall back to ENV_NAME when AWS execution runtime is present', () => {
    expect(
      resolveRuntimeEnvMode(
        env({
          RUNTIME_DEPLOYMENT_ENV: undefined,
          AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs24.x',
          AWS_LAMBDA_FUNCTION_NAME: undefined,
          ENV_NAME: 'develop',
        }),
      ),
    ).toBe('unknown');
  });

  it('prefers explicit runtime deployment marker over unrecognized Lambda function names', () => {
    expect(
      resolveRuntimeEnvMode(
        env({
          RUNTIME_DEPLOYMENT_ENV: 'develop',
          AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs24.x',
          ENV_NAME: undefined,
          AWS_LAMBDA_FUNCTION_NAME: 'custom-prod-worker',
        }),
      ),
    ).toBe('non-production');
  });
});

describe('resolveRuntimeEnvMode', () => {
  it('returns unknown when deployment markers are missing', () => {
    expect(
      resolveRuntimeEnvMode(
        env({
          RUNTIME_DEPLOYMENT_ENV: undefined,
          AWS_EXECUTION_ENV: undefined,
          ENV_NAME: undefined,
          AWS_LAMBDA_FUNCTION_NAME: undefined,
        }),
      ),
    ).toBe('unknown');
  });

  it('returns unknown for unsupported marker values', () => {
    expect(
      resolveRuntimeEnvMode(
        env({
          RUNTIME_DEPLOYMENT_ENV: 'preview',
          AWS_LAMBDA_FUNCTION_NAME: 'custom-runtime-handler',
          ENV_NAME: 'sandbox',
        }),
      ),
    ).toBe('unknown');
  });
});
