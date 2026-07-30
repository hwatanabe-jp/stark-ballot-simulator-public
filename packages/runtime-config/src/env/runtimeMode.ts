function normalize(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function classify(value: string | null): 'production' | 'non-production' | null {
  if (!value) {
    return null;
  }
  if (value === 'main' || value === 'production' || value === 'prod') {
    return 'production';
  }
  if (value === 'develop' || value === 'dev') {
    return 'non-production';
  }
  return null;
}

function classifyLambdaFunctionName(value: string | undefined): 'production' | 'non-production' | null {
  const normalized = normalize(value);
  if (!normalized) {
    return null;
  }

  const targetLambdaMatch =
    /^stark-ballot-simulator-(stark-dev-develop|stark-prod-main)-(public-api|finalization-writer|proof-dispatcher|verification-worker|semaphore-janitor)$/.exec(
      normalized,
    );
  if (!targetLambdaMatch) {
    return null;
  }

  const [, targetScope] = targetLambdaMatch;
  if (targetScope === 'stark-dev-develop') {
    return 'non-production';
  }
  if (targetScope === 'stark-prod-main') {
    return 'production';
  }

  return null;
}

function hasMarker(value: string | undefined): boolean {
  return normalize(value) !== null;
}

/**
 * Runtime deployment classification derived from branch/env markers.
 * `unknown` indicates that no trusted marker could be mapped.
 */
export type RuntimeEnvMode = 'production' | 'non-production' | 'unknown';

/**
 * Resolve runtime mode from deployment markers in descending trust order.
 */
export function resolveRuntimeEnvMode(env: NodeJS.ProcessEnv = process.env): RuntimeEnvMode {
  // Prefer target deployment scope markers over NODE_ENV.
  const runtimeEnvClassification = classify(normalize(env['RUNTIME_DEPLOYMENT_ENV']));
  if (runtimeEnvClassification === 'production') {
    return 'production';
  }
  if (runtimeEnvClassification === 'non-production') {
    return 'non-production';
  }

  const lambdaFunctionClassification = classifyLambdaFunctionName(env['AWS_LAMBDA_FUNCTION_NAME']);
  if (lambdaFunctionClassification === 'production') {
    return 'production';
  }
  if (lambdaFunctionClassification === 'non-production') {
    return 'non-production';
  }
  if (hasMarker(env['AWS_LAMBDA_FUNCTION_NAME']) || hasMarker(env['AWS_EXECUTION_ENV'])) {
    return 'unknown';
  }

  const envNameClassification = classify(normalize(env['ENV_NAME']));
  if (envNameClassification === 'production') {
    return 'production';
  }
  if (envNameClassification === 'non-production') {
    return 'non-production';
  }

  return 'unknown';
}

export function isProductionRuntimeEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveRuntimeEnvMode(env) === 'production';
}
