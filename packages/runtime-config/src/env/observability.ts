import { isPublicDefaultLogSalt } from '@stark-ballot/validation/log-hash-salt';
import { RuntimeConfigValidationError } from '@stark-ballot/runtime-config/env/configValidationError';

export type TargetObservabilityConfigName =
  'LOG_IP_HASH_SALT_REF' | 'LOG_IP_HASH_SALT' | 'LOG_FORMAT' | 'DEPLOYMENT_ID' | 'APP_SOURCE_SHA' | 'DEPLOY_MODE';

function readTrimmedEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function observabilityConfigError(name: TargetObservabilityConfigName, message: string): RuntimeConfigValidationError {
  return new RuntimeConfigValidationError([name], undefined, message);
}

function requireTargetEnv(env: NodeJS.ProcessEnv, name: TargetObservabilityConfigName): string {
  const value = readTrimmedEnv(env, name);
  if (!value) {
    throw observabilityConfigError(name, `${name} must be set when TARGET_AWS_RUNTIME=1.`);
  }
  return value;
}

export function collectInvalidTargetObservabilityEnvNames(
  env: NodeJS.ProcessEnv = process.env,
): TargetObservabilityConfigName[] {
  if (env['TARGET_AWS_RUNTIME'] !== '1') {
    return [];
  }

  const invalidNames: TargetObservabilityConfigName[] = [];
  if (!readTrimmedEnv(env, 'LOG_IP_HASH_SALT_REF')) {
    invalidNames.push('LOG_IP_HASH_SALT_REF');
  }
  const logHashSalt = readTrimmedEnv(env, 'LOG_IP_HASH_SALT');
  if (!logHashSalt || isPublicDefaultLogSalt(logHashSalt)) {
    invalidNames.push('LOG_IP_HASH_SALT');
  }
  if (env['LOG_FORMAT'] !== 'json') {
    invalidNames.push('LOG_FORMAT');
  }
  const deploymentId = readTrimmedEnv(env, 'DEPLOYMENT_ID');
  if (!deploymentId || !/^dep_[0-9a-f]{32}$/.test(deploymentId)) {
    invalidNames.push('DEPLOYMENT_ID');
  }
  const appSourceSha = readTrimmedEnv(env, 'APP_SOURCE_SHA');
  if (!appSourceSha || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(appSourceSha)) {
    invalidNames.push('APP_SOURCE_SHA');
  }
  const deployMode = readTrimmedEnv(env, 'DEPLOY_MODE');
  if (deployMode !== 'normal' && deployMode !== 'rollback') {
    invalidNames.push('DEPLOY_MODE');
  }
  return invalidNames;
}

export function validateTargetObservabilityEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env['TARGET_AWS_RUNTIME'] !== '1') {
    return;
  }

  requireTargetEnv(env, 'LOG_IP_HASH_SALT_REF');
  const logHashSalt = readTrimmedEnv(env, 'LOG_IP_HASH_SALT');
  if (!logHashSalt) {
    throw observabilityConfigError(
      'LOG_IP_HASH_SALT',
      'LOG_IP_HASH_SALT must be resolved from LOG_IP_HASH_SALT_REF when TARGET_AWS_RUNTIME=1.',
    );
  }
  if (isPublicDefaultLogSalt(logHashSalt)) {
    throw observabilityConfigError(
      'LOG_IP_HASH_SALT',
      'LOG_IP_HASH_SALT must not use the public local-development default when TARGET_AWS_RUNTIME=1.',
    );
  }
  if (env['LOG_FORMAT'] !== 'json') {
    throw observabilityConfigError('LOG_FORMAT', 'LOG_FORMAT=json is required when TARGET_AWS_RUNTIME=1.');
  }

  const deploymentId = requireTargetEnv(env, 'DEPLOYMENT_ID');
  if (!/^dep_[0-9a-f]{32}$/.test(deploymentId)) {
    throw observabilityConfigError(
      'DEPLOYMENT_ID',
      'DEPLOYMENT_ID must be an opaque deployment digest when TARGET_AWS_RUNTIME=1.',
    );
  }

  const appSourceSha = requireTargetEnv(env, 'APP_SOURCE_SHA');
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(appSourceSha)) {
    throw observabilityConfigError(
      'APP_SOURCE_SHA',
      'APP_SOURCE_SHA must be the full selected source SHA when TARGET_AWS_RUNTIME=1.',
    );
  }

  const deployMode = requireTargetEnv(env, 'DEPLOY_MODE');
  if (deployMode !== 'normal' && deployMode !== 'rollback') {
    throw observabilityConfigError('DEPLOY_MODE', 'DEPLOY_MODE must be normal or rollback when TARGET_AWS_RUNTIME=1.');
  }
}
