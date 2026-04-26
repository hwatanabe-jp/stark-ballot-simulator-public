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

  // Amplify Lambda names encode branch token in the third segment:
  // amplify-<appId>-<branchToken>-<resourceName>.
  const amplifyLambdaMatch = /^amplify-[^-]+-([a-z0-9]+)-/.exec(normalized);
  if (amplifyLambdaMatch) {
    const branchToken = amplifyLambdaMatch[1];
    if (branchToken === 'main' || branchToken === 'ma' || branchToken === 'production' || branchToken === 'prod') {
      return 'production';
    }
    if (branchToken === 'develop' || branchToken === 'devel' || branchToken === 'dev' || branchToken === 'de') {
      return 'non-production';
    }
  }

  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.includes('main') || tokens.includes('production') || tokens.includes('prod')) {
    return 'production';
  }
  if (tokens.includes('develop') || tokens.includes('devel') || tokens.includes('dev')) {
    return 'non-production';
  }

  return null;
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
  // Prefer deployment scope markers over NODE_ENV.
  // Amplify SSR always runs with NODE_ENV=production, even on non-production branches.
  const awsBranchClassification = classify(normalize(env.AWS_BRANCH));
  if (awsBranchClassification === 'production') {
    return 'production';
  }
  if (awsBranchClassification === 'non-production') {
    return 'non-production';
  }

  const amplifyBranchClassification = classify(normalize(env.AMPLIFY_BRANCH));
  if (amplifyBranchClassification === 'production') {
    return 'production';
  }
  if (amplifyBranchClassification === 'non-production') {
    return 'non-production';
  }

  const runtimeEnvClassification = classify(normalize(env.RUNTIME_DEPLOYMENT_ENV));
  if (runtimeEnvClassification === 'production') {
    return 'production';
  }
  if (runtimeEnvClassification === 'non-production') {
    return 'non-production';
  }

  const lambdaFunctionClassification = classifyLambdaFunctionName(env.AWS_LAMBDA_FUNCTION_NAME);
  if (lambdaFunctionClassification === 'production') {
    return 'production';
  }
  if (lambdaFunctionClassification === 'non-production') {
    return 'non-production';
  }

  const envNameClassification = classify(normalize(env.ENV_NAME));
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
