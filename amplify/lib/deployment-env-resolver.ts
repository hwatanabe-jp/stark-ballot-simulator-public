export type DeploymentEnv = 'develop' | 'main';
export type DeploymentEnvKey = 'AWS_BRANCH' | 'AMPLIFY_BRANCH' | 'ENV_NAME';

const MAIN_MARKERS = new Set(['main', 'production', 'prod']);
const DEVELOP_MARKERS = new Set(['develop', 'development', 'dev', 'sandbox']);

export const REQUIRED_DEPLOYMENT_ENV_KEYS: readonly DeploymentEnvKey[] = ['AWS_BRANCH'];

function normalizeOptionalEnv(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

function classifyDeploymentEnv(value: string): DeploymentEnv | null {
  if (MAIN_MARKERS.has(value)) {
    return 'main';
  }
  if (DEVELOP_MARKERS.has(value)) {
    return 'develop';
  }
  return null;
}

export function assertRequiredDeploymentEnvVars(env: Pick<NodeJS.ProcessEnv, DeploymentEnvKey> = process.env): void {
  const missingKeys = REQUIRED_DEPLOYMENT_ENV_KEYS.filter((key) => normalizeOptionalEnv(env[key]) === null);
  if (missingKeys.length === 0) {
    return;
  }
  throw new Error(`Missing required deployment environment variables: ${missingKeys.join(', ')}`);
}

export function resolveDeploymentEnv(env: Pick<NodeJS.ProcessEnv, DeploymentEnvKey> = process.env): DeploymentEnv {
  assertRequiredDeploymentEnvVars(env);

  // Deployment environment resolution is intentionally based only on AWS_BRANCH.
  // Other markers may be present in app-level env vars and must not alter branch routing.
  const normalizedBranch = normalizeOptionalEnv(env.AWS_BRANCH);
  if (!normalizedBranch) {
    throw new Error('Missing required deployment environment variables: AWS_BRANCH');
  }

  const classifiedEnv = classifyDeploymentEnv(normalizedBranch);
  if (!classifiedEnv) {
    throw new Error(
      `Unsupported deployment environment marker values: AWS_BRANCH=${normalizedBranch}. Allowed values: main|production|prod or develop|development|dev|sandbox.`,
    );
  }

  return classifiedEnv;
}
