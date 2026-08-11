import { isUnresolvedRuntimeSecretPlaceholder } from '@stark-ballot/runtime-config/env/runtimeSecretPlaceholders';
import { RuntimeConfigValidationError } from '@stark-ballot/runtime-config/env/configValidationError';

export type RuntimeConfigReferenceName =
  | 'SESSION_CAPABILITY_SECRET'
  | 'VOTE_SECRET_ENCRYPTION_KEY'
  | 'SESSION_CAPABILITY_TTL_SECONDS'
  | 'TURNSTILE_SECRET_KEY'
  | 'LOG_IP_HASH_SALT'
  | 'EXPECTED_ORIGIN_VERIFY_HEADER'
  | 'VITE_TURNSTILE_SITE_KEY';

type RuntimeConfigReferenceEnvName = `${RuntimeConfigReferenceName}_REF`;

export interface RuntimeConfigReference {
  name: RuntimeConfigReferenceName;
  reference: string;
}

export interface RuntimeConfigReferenceResolver {
  resolve(reference: RuntimeConfigReference): string | undefined;
}

export interface RuntimeConfigReferenceValidationOptions {
  expectedAccountId?: string;
  expectedDeploymentEnvironment: 'develop' | 'main';
  expectedRegion?: string;
}

interface BoundRuntimeConfigReferenceResolver {
  readonly resolver: RuntimeConfigReferenceResolver;
  readonly validationOptions: Readonly<RuntimeConfigReferenceValidationOptions>;
}

let activeResolver: BoundRuntimeConfigReferenceResolver | undefined;

const TARGET_RUNTIME_REFERENCE_IDENTITIES = [
  { accountAlias: 'stark-dev', deploymentEnvironment: 'develop' },
  { accountAlias: 'stark-prod', deploymentEnvironment: 'main' },
] as const;

const TARGET_RUNTIME_REFERENCE_SUFFIXES: Record<RuntimeConfigReferenceName, string> = {
  SESSION_CAPABILITY_SECRET: 'secrets/session-capability-secret',
  VOTE_SECRET_ENCRYPTION_KEY: 'secrets/vote-secret-encryption-key',
  SESSION_CAPABILITY_TTL_SECONDS: 'config/session-capability-ttl-seconds',
  TURNSTILE_SECRET_KEY: 'secrets/turnstile-secret-key',
  LOG_IP_HASH_SALT: 'secrets/log-ip-hash-salt',
  EXPECTED_ORIGIN_VERIFY_HEADER: 'secrets/expected-origin-verify-header',
  VITE_TURNSTILE_SITE_KEY: 'config/vite-turnstile-site-key',
};

function normalizeAbsolutePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function secretNameMatchesExpectedPath(secretResource: string, expectedPath: string): boolean {
  const secretName = normalizeAbsolutePath(secretResource);
  return secretName === expectedPath || new RegExp(`^${escapeRegExp(expectedPath)}-[A-Za-z0-9]{6}$`).test(secretName);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function referenceEnvName(name: RuntimeConfigReferenceName): RuntimeConfigReferenceEnvName {
  return `${name}_REF`;
}

function referenceConfigError(name: RuntimeConfigReferenceName, message: string): RuntimeConfigValidationError {
  return new RuntimeConfigValidationError([referenceEnvName(name)], undefined, message);
}

function requiredMatchGroup(
  name: RuntimeConfigReferenceName,
  match: RegExpExecArray,
  index: number,
  errorMessage: string,
): string {
  const value = match[index];
  if (!value) {
    throw referenceConfigError(name, errorMessage);
  }
  return value;
}

export function expectedRuntimeConfigReferencePath(
  name: RuntimeConfigReferenceName,
  deploymentEnvironment: 'develop' | 'main' = 'develop',
): string {
  return expectedRuntimeConfigReferencePaths(name, { expectedDeploymentEnvironment: deploymentEnvironment })[0] ?? '';
}

function expectedRuntimeConfigReferencePaths(
  name: RuntimeConfigReferenceName,
  options: RuntimeConfigReferenceValidationOptions,
): string[] {
  const identities = TARGET_RUNTIME_REFERENCE_IDENTITIES.filter(
    (identity) => identity.deploymentEnvironment === options.expectedDeploymentEnvironment,
  );
  const suffix = TARGET_RUNTIME_REFERENCE_SUFFIXES[name];
  return identities.map(
    (identity) => `/stark-ballot-simulator/${identity.accountAlias}/${identity.deploymentEnvironment}/app/${suffix}`,
  );
}

function formatExpectedReferencePaths(paths: readonly string[]): string {
  return paths.length === 1 ? (paths[0] ?? '') : `one of ${paths.join(', ')}`;
}

function assertExpectedReferencePath(
  name: RuntimeConfigReferenceName,
  actualPath: string,
  expectedPaths: string[],
): void {
  if (!expectedPaths.includes(actualPath)) {
    throw referenceConfigError(name, `${name}_REF must reference ${formatExpectedReferencePaths(expectedPaths)}.`);
  }
}

export function validateRuntimeConfigReferenceSource(
  name: RuntimeConfigReferenceName,
  rawReference: string | undefined,
  options: RuntimeConfigReferenceValidationOptions,
): string {
  const value = rawReference?.trim();
  if (!value) {
    throw referenceConfigError(name, `${name}_REF must be set to an SSM parameter path or approved secret/config ARN.`);
  }
  if (isUnresolvedRuntimeSecretPlaceholder(value)) {
    throw referenceConfigError(name, `${name}_REF must not be an unresolved runtime secret placeholder.`);
  }

  const lowered = value.toLowerCase();
  if (
    lowered.includes('amplify') ||
    lowered.includes('legacy') ||
    lowered.includes('placeholder') ||
    lowered.startsWith('change-me')
  ) {
    throw referenceConfigError(name, `${name}_REF must reference a target-account SSM or Secrets Manager source.`);
  }

  const expectedPaths = expectedRuntimeConfigReferencePaths(name, options);
  if (value.startsWith('/')) {
    assertExpectedReferencePath(name, value, expectedPaths);
    return value;
  }

  const arnMatch = /^arn:aws:(ssm|secretsmanager):([^:]+):([0-9]{12}):(.+)$/.exec(value);
  if (arnMatch) {
    const service = requiredMatchGroup(
      name,
      arnMatch,
      1,
      `${name}_REF must be an absolute SSM parameter path or approved secret/config ARN.`,
    );
    const region = requiredMatchGroup(
      name,
      arnMatch,
      2,
      `${name}_REF must be an absolute SSM parameter path or approved secret/config ARN.`,
    );
    const accountId = requiredMatchGroup(
      name,
      arnMatch,
      3,
      `${name}_REF must be an absolute SSM parameter path or approved secret/config ARN.`,
    );
    const resource = requiredMatchGroup(
      name,
      arnMatch,
      4,
      `${name}_REF must be an absolute SSM parameter path or approved secret/config ARN.`,
    );
    if (options.expectedRegion && region !== options.expectedRegion) {
      throw referenceConfigError(name, `${name}_REF region must match AWS_REGION/AWS_DEFAULT_REGION.`);
    }
    if (options.expectedAccountId && accountId !== options.expectedAccountId) {
      throw referenceConfigError(name, `${name}_REF account must match AWS_ACCOUNT_ID.`);
    }
    if (service === 'ssm') {
      if (!resource.startsWith('parameter/')) {
        throw referenceConfigError(name, `${name}_REF must reference an SSM parameter or Secrets Manager secret.`);
      }
      const parameterPath = normalizeAbsolutePath(resource.slice('parameter/'.length));
      assertExpectedReferencePath(name, parameterPath, expectedPaths);
      return value;
    }
    if (!resource.startsWith('secret:')) {
      throw referenceConfigError(name, `${name}_REF must reference an SSM parameter or Secrets Manager secret.`);
    }
    const secretName = resource.slice('secret:'.length);
    if (!expectedPaths.some((expectedPath) => secretNameMatchesExpectedPath(secretName, expectedPath))) {
      throw referenceConfigError(name, `${name}_REF must reference ${formatExpectedReferencePaths(expectedPaths)}.`);
    }
    return value;
  }

  throw referenceConfigError(name, `${name}_REF must be an absolute SSM parameter path or approved secret/config ARN.`);
}

function normalizeReference(
  reference: RuntimeConfigReference,
  validationOptions: RuntimeConfigReferenceValidationOptions,
): RuntimeConfigReference {
  if (!reference.reference.trim()) {
    throw referenceConfigError(reference.name, `${reference.name}_REF must be set before resolving ${reference.name}.`);
  }

  const value = validateRuntimeConfigReferenceSource(reference.name, reference.reference, validationOptions);
  return { name: reference.name, reference: value };
}

export function setRuntimeConfigReferenceResolver(
  resolver: RuntimeConfigReferenceResolver,
  validationOptions: RuntimeConfigReferenceValidationOptions,
): void {
  activeResolver = {
    resolver,
    validationOptions: Object.freeze({ ...validationOptions }),
  };
}

export function clearRuntimeConfigReferenceResolver(): void {
  activeResolver = undefined;
}

export function installStaticRuntimeConfigReferenceResolver(
  values: ReadonlyMap<string, string>,
  validationOptions: RuntimeConfigReferenceValidationOptions,
): void {
  setRuntimeConfigReferenceResolver(
    {
      resolve(reference) {
        return values.get(reference.reference);
      },
    },
    validationOptions,
  );
}

export function resolveRuntimeConfigReference(reference: RuntimeConfigReference): string {
  if (!activeResolver) {
    throw referenceConfigError(
      reference.name,
      `${reference.name}_REF is configured but no target runtime resolver returned a value.`,
    );
  }
  const normalized = normalizeReference(reference, activeResolver.validationOptions);
  const resolved = activeResolver.resolver.resolve(normalized)?.trim();

  if (!resolved) {
    throw referenceConfigError(
      normalized.name,
      `${normalized.name}_REF is configured but no target runtime resolver returned a value.`,
    );
  }
  if (resolved === normalized.reference || isUnresolvedRuntimeSecretPlaceholder(resolved)) {
    throw referenceConfigError(
      normalized.name,
      `${normalized.name}_REF resolved to an unresolved or invalid ${normalized.name} value.`,
    );
  }

  return resolved;
}
