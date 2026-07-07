import {
  DEFAULT_SESSION_CAPABILITY_TTL_SECONDS,
  MAX_SESSION_CAPABILITY_TTL_SECONDS,
} from '@stark-ballot/domain/security/sessionCapabilityToken';
import { isUnresolvedRuntimeSecretPlaceholder } from '@stark-ballot/runtime-config/env/runtimeSecretPlaceholders';
import { resolveRuntimeConfigReference } from '@stark-ballot/runtime-config/env/runtimeConfigReferences';

const MIN_SECRET_LENGTH = 32;
const DISALLOWED_SESSION_CAPABILITY_SECRETS = new Set([
  'change-me-please-min-32-chars',
  'test-session-capability-secret-0123456789abcdef',
]);

function assertAllowedSessionCapabilitySecret(secret: string, env: NodeJS.ProcessEnv): string {
  if (isUnresolvedRuntimeSecretPlaceholder(secret)) {
    throw new Error('SESSION_CAPABILITY_SECRET was not resolved from runtime secret references');
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error('SESSION_CAPABILITY_SECRET must be set to at least 32 characters');
  }
  const lowered = secret.toLowerCase();
  if (secret.startsWith('/') || lowered.startsWith('arn:aws:')) {
    throw new Error('SESSION_CAPABILITY_SECRET must contain raw secret material, not a reference.');
  }

  if (
    env['NODE_ENV'] !== 'test' &&
    (DISALLOWED_SESSION_CAPABILITY_SECRETS.has(lowered) || lowered.startsWith('change-me-please'))
  ) {
    throw new Error('SESSION_CAPABILITY_SECRET must be changed from placeholder/test values');
  }

  return secret;
}

function isTargetNonMockRuntime(env: NodeJS.ProcessEnv): boolean {
  return env['USE_MOCK_STORE']?.trim().toLowerCase() === 'false';
}

function assertNoTargetRawRuntimeValue(name: string, rawValue: string | undefined): void {
  if (rawValue?.trim()) {
    throw new Error(`${name} must not be set directly when USE_MOCK_STORE=false; use ${name}_REF.`);
  }
}

export function resolveSessionCapabilitySecret(env: NodeJS.ProcessEnv = process.env): string {
  if (isTargetNonMockRuntime(env)) {
    assertNoTargetRawRuntimeValue('SESSION_CAPABILITY_SECRET', env['SESSION_CAPABILITY_SECRET']);
    const secretRef = env['SESSION_CAPABILITY_SECRET_REF']?.trim();
    if (!secretRef) {
      throw new Error('SESSION_CAPABILITY_SECRET_REF must be set before resolving SESSION_CAPABILITY_SECRET.');
    }
    const resolved = resolveRuntimeConfigReference({
      name: 'SESSION_CAPABILITY_SECRET',
      reference: secretRef,
    });
    return assertAllowedSessionCapabilitySecret(resolved, env);
  }

  const secret = env['SESSION_CAPABILITY_SECRET']?.trim();
  if (secret) {
    return assertAllowedSessionCapabilitySecret(secret, env);
  }

  const secretRef = env['SESSION_CAPABILITY_SECRET_REF']?.trim();
  if (secretRef) {
    const resolved = resolveRuntimeConfigReference({
      name: 'SESSION_CAPABILITY_SECRET',
      reference: secretRef,
    });
    return assertAllowedSessionCapabilitySecret(resolved, env);
  }

  throw new Error('SESSION_CAPABILITY_SECRET must be set to at least 32 characters');
}

export function resolveSessionCapabilityTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const directRaw = env['SESSION_CAPABILITY_TTL_SECONDS']?.trim();
  const ttlRef = env['SESSION_CAPABILITY_TTL_SECONDS_REF']?.trim();
  if (isTargetNonMockRuntime(env)) {
    assertNoTargetRawRuntimeValue('SESSION_CAPABILITY_TTL_SECONDS', directRaw);
    if (!ttlRef) {
      throw new Error(
        'SESSION_CAPABILITY_TTL_SECONDS_REF must be set before resolving SESSION_CAPABILITY_TTL_SECONDS.',
      );
    }
  }
  const raw =
    directRaw && directRaw.length > 0
      ? directRaw
      : ttlRef
        ? resolveRuntimeConfigReference({
            name: 'SESSION_CAPABILITY_TTL_SECONDS',
            reference: ttlRef,
          })
        : undefined;
  if (!raw) {
    return DEFAULT_SESSION_CAPABILITY_TTL_SECONDS;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid SESSION_CAPABILITY_TTL_SECONDS value: ${raw}. Expected a positive integer.`);
  }
  if (parsed > MAX_SESSION_CAPABILITY_TTL_SECONDS) {
    throw new Error(`SESSION_CAPABILITY_TTL_SECONDS must be ${MAX_SESSION_CAPABILITY_TTL_SECONDS} or less.`);
  }

  return parsed;
}
