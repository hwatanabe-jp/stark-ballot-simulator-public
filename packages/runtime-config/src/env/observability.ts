import { isPublicDefaultLogSalt } from '@stark-ballot/validation/log-hash-salt';
import { RuntimeConfigValidationError } from '@stark-ballot/runtime-config/env/configValidationError';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

export type TargetObservabilityConfigName =
  | 'LOG_IP_HASH_SALT_REF'
  | 'LOG_IP_HASH_SALT'
  | 'LOG_FORMAT'
  | 'DEPLOYMENT_ID'
  | 'APP_SOURCE_SHA'
  | 'DEPLOY_MODE';

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
    throw observabilityConfigError(name, `${name} must be set for the target AWS runtime profile.`);
  }
  return value;
}

export function validateTargetObservabilityEnv(profile: ResolvedRuntimeProfile, env: NodeJS.ProcessEnv): void {
  if (profile.target.kind !== 'aws') {
    return;
  }

  requireTargetEnv(env, 'LOG_IP_HASH_SALT_REF');
  const logHashSalt = readTrimmedEnv(env, 'LOG_IP_HASH_SALT');
  if (!logHashSalt) {
    throw observabilityConfigError(
      'LOG_IP_HASH_SALT',
      'LOG_IP_HASH_SALT must be resolved from LOG_IP_HASH_SALT_REF for the target AWS runtime profile.',
    );
  }
  if (isPublicDefaultLogSalt(logHashSalt)) {
    throw observabilityConfigError(
      'LOG_IP_HASH_SALT',
      'LOG_IP_HASH_SALT must not use the public local-development default for the target AWS runtime profile.',
    );
  }
  if (env['LOG_FORMAT'] !== 'json') {
    throw observabilityConfigError('LOG_FORMAT', 'LOG_FORMAT=json is required for the target AWS runtime profile.');
  }

  const deploymentId = requireTargetEnv(env, 'DEPLOYMENT_ID');
  if (!/^dep_[0-9a-f]{32}$/.test(deploymentId)) {
    throw observabilityConfigError(
      'DEPLOYMENT_ID',
      'DEPLOYMENT_ID must be an opaque deployment digest for the target AWS runtime profile.',
    );
  }

  const appSourceSha = requireTargetEnv(env, 'APP_SOURCE_SHA');
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(appSourceSha)) {
    throw observabilityConfigError(
      'APP_SOURCE_SHA',
      'APP_SOURCE_SHA must be the full selected source SHA for the target AWS runtime profile.',
    );
  }

  const deployMode = requireTargetEnv(env, 'DEPLOY_MODE');
  if (deployMode !== 'normal' && deployMode !== 'rollback') {
    throw observabilityConfigError(
      'DEPLOY_MODE',
      'DEPLOY_MODE must be normal or rollback for the target AWS runtime profile.',
    );
  }
}
