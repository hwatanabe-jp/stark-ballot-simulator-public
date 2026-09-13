import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearRuntimeConfigReferenceResolver,
  resolveRuntimeConfigReference,
} from '@stark-ballot/runtime-config/env/runtimeConfigReferences';
import {
  localRuntimeProfile,
  targetRuntimeProfile,
  targetRuntimeProfileEnv,
} from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';
import { resolveRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import {
  ensureAwsRuntimeConfigReferencesLoaded,
  loadAwsRuntimeConfigReferences,
  loadAwsRuntimeConfigReferencesForEntrypoint,
  resetAwsRuntimeConfigReferenceResolverForTests,
  type AwsRuntimeEntrypoint,
} from '@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver';
import {
  createSessionCapabilityToken,
  verifySessionCapabilityToken,
} from '@stark-ballot/domain/security/sessionCapabilityToken';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import { encryptVoteSecret } from '@stark-ballot/aws-adapters/security/voteSecretCipher';

const SESSION_SECRET_REF = '/stark-ballot-simulator/stark-dev/develop/app/secrets/session-capability-secret';
const VOTE_SECRET_REF = '/stark-ballot-simulator/stark-dev/develop/app/secrets/vote-secret-encryption-key';
const SESSION_TTL_REF = '/stark-ballot-simulator/stark-dev/develop/app/config/session-capability-ttl-seconds';
const TURNSTILE_SECRET_REF = '/stark-ballot-simulator/stark-dev/develop/app/secrets/turnstile-secret-key';
const ORIGIN_VERIFY_HEADER_REF = '/stark-ballot-simulator/stark-dev/develop/app/secrets/expected-origin-verify-header';
const LOG_IP_HASH_SALT_REF = '/stark-ballot-simulator/stark-dev/develop/app/secrets/log-ip-hash-salt';
const SESSION_SECRET = 'resolved-session-capability-secret-0123456789abcdef';
const VOTE_SECRET = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const LOG_IP_HASH_SALT = 'resolved-log-ip-hash-salt';
const ORIGIN_VERIFY_HEADER = 'resolved-origin-verify-header-0123456789abcdef';
const originalEnv = { ...process.env };
const activeTargetProfile = targetRuntimeProfile();
const quiescedTargetProfile = resolveRuntimeProfile({
  ...targetRuntimeProfileEnv(),
  RUNTIME_PROFILE: 'target-aws-async-quiesced',
});
const localProfile = localRuntimeProfile();
const nonTurnstileEntrypoints = [
  'finalization_writer',
  'proof_dispatcher',
  'verification_worker',
] as const satisfies readonly AwsRuntimeEntrypoint[];

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
}

function targetEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RUNTIME_PROFILE: 'target-aws-async',
    AWS_ACCOUNT_ID: '123456789012',
    AWS_REGION: 'ap-northeast-1',
    SESSION_CAPABILITY_SECRET_REF: SESSION_SECRET_REF,
    VOTE_SECRET_ENCRYPTION_KEY_REF: VOTE_SECRET_REF,
    SESSION_CAPABILITY_TTL_SECONDS_REF: SESSION_TTL_REF,
    TURNSTILE_SECRET_KEY_REF: TURNSTILE_SECRET_REF,
    EXPECTED_ORIGIN_VERIFY_HEADER_REF: ORIGIN_VERIFY_HEADER_REF,
    LOG_IP_HASH_SALT_REF,
  };
}

function applyTargetProcessEnv(): void {
  process.env['RUNTIME_PROFILE'] = 'target-aws-async';
  process.env['AWS_ACCOUNT_ID'] = '123456789012';
  process.env['AWS_REGION'] = 'ap-northeast-1';
  process.env['SESSION_CAPABILITY_SECRET_REF'] = SESSION_SECRET_REF;
  process.env['VOTE_SECRET_ENCRYPTION_KEY_REF'] = VOTE_SECRET_REF;
  process.env['SESSION_CAPABILITY_TTL_SECONDS_REF'] = SESSION_TTL_REF;
  process.env['TURNSTILE_SECRET_KEY_REF'] = TURNSTILE_SECRET_REF;
  process.env['EXPECTED_ORIGIN_VERIFY_HEADER_REF'] = ORIGIN_VERIFY_HEADER_REF;
  process.env['LOG_IP_HASH_SALT_REF'] = LOG_IP_HASH_SALT_REF;
  delete process.env['SESSION_CAPABILITY_SECRET'];
  delete process.env['VOTE_SECRET_ENCRYPTION_KEY'];
  delete process.env['SESSION_CAPABILITY_TTL_SECONDS'];
  delete process.env['EXPECTED_ORIGIN_VERIFY_HEADER'];
  delete process.env['LOG_IP_HASH_SALT'];
}

describe('awsRuntimeConfigReferenceResolver', () => {
  afterEach(() => {
    clearRuntimeConfigReferenceResolver();
    resetAwsRuntimeConfigReferenceResolverForTests();
    vi.unstubAllEnvs();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('loads target references from AWS sources and installs a synchronous resolver', async () => {
    const send = vi.fn(async (command: { input?: { Name?: string; SecretId?: string } }) => {
      await Promise.resolve();
      if (command.input?.Name === VOTE_SECRET_REF || command.input?.Name === TURNSTILE_SECRET_REF) {
        throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
      }
      const reference = command.input?.Name ?? command.input?.SecretId;
      if (!reference) {
        throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
      }
      switch (reference) {
        case SESSION_SECRET_REF:
          return { SecretString: SESSION_SECRET };
        case SESSION_TTL_REF:
          return { Parameter: { Value: '120' } };
        case VOTE_SECRET_REF:
          return { SecretString: VOTE_SECRET };
        case TURNSTILE_SECRET_REF:
          return { SecretString: 'turnstile-secret-value' };
        case ORIGIN_VERIFY_HEADER_REF:
          return { SecretString: ORIGIN_VERIFY_HEADER };
        case LOG_IP_HASH_SALT_REF:
          return { SecretString: LOG_IP_HASH_SALT };
        default:
          throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
      }
    });

    const env = targetEnv();
    await loadAwsRuntimeConfigReferences({
      profile: activeTargetProfile,
      env,
      ssmClient: { send },
      secretsManagerClient: { send },
    });

    expect(
      resolveRuntimeConfigReference({
        name: 'SESSION_CAPABILITY_SECRET',
        reference: SESSION_SECRET_REF,
      }),
    ).toBe(SESSION_SECRET);
    expect(
      resolveRuntimeConfigReference({
        name: 'VOTE_SECRET_ENCRYPTION_KEY',
        reference: VOTE_SECRET_REF,
      }),
    ).toBe(VOTE_SECRET);
    expect(
      resolveRuntimeConfigReference({
        name: 'TURNSTILE_SECRET_KEY',
        reference: TURNSTILE_SECRET_REF,
      }),
    ).toBe('turnstile-secret-value');
    expect(env['EXPECTED_ORIGIN_VERIFY_HEADER']).toBe(ORIGIN_VERIFY_HEADER);
    expect(env['LOG_IP_HASH_SALT']).toBe(LOG_IP_HASH_SALT);
  });

  it('rejects a reference changed after profile resolution before reading from AWS', async () => {
    const env = targetEnv();
    env['SESSION_CAPABILITY_SECRET_REF'] =
      '/stark-ballot-simulator/stark-dev/develop/app/secrets/replaced-session-capability-secret';
    const send = vi.fn();
    const invalidNameCollector = {
      add: vi.fn(),
    };

    await expect(
      loadAwsRuntimeConfigReferences({
        profile: activeTargetProfile,
        env,
        ssmClient: { send },
        secretsManagerClient: { send },
        invalidNameCollector,
      }),
    ).rejects.toThrow('SESSION_CAPABILITY_SECRET_REF must match the reference captured by the runtime profile');

    expect(invalidNameCollector.add).toHaveBeenCalledTimes(1);
    expect(invalidNameCollector.add).toHaveBeenCalledWith('SESSION_CAPABILITY_SECRET_REF');
    expect(send).not.toHaveBeenCalled();
  });

  it('supports capability-token and vote-secret resolution in target non-mock mode after AWS preload', async () => {
    const ssmSend = vi.fn(async (command: { input?: { Name?: string } }) => {
      await Promise.resolve();
      const reference = command.input?.Name;
      if (!reference) {
        throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
      }
      switch (reference) {
        case SESSION_TTL_REF:
          return { Parameter: { Value: '120' } };
        default:
          throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
      }
    });
    const secretsSend = vi.fn(async (command: { input?: { SecretId?: string } }) => {
      await Promise.resolve();
      const reference = command.input?.SecretId;
      if (!reference) {
        throw Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
      }
      switch (reference) {
        case SESSION_SECRET_REF:
          return { SecretString: SESSION_SECRET };
        case VOTE_SECRET_REF:
          return { SecretString: VOTE_SECRET };
        case TURNSTILE_SECRET_REF:
          return { SecretString: 'turnstile-secret-value' };
        case ORIGIN_VERIFY_HEADER_REF:
          return { SecretString: ORIGIN_VERIFY_HEADER };
        case LOG_IP_HASH_SALT_REF:
          return { SecretString: LOG_IP_HASH_SALT };
        default:
          throw Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
      }
    });

    await loadAwsRuntimeConfigReferences({
      profile: activeTargetProfile,
      env: targetEnv(),
      ssmClient: { send: ssmSend },
      secretsManagerClient: { send: secretsSend },
    });
    applyTargetProcessEnv();

    const secret = resolveRuntimeConfigReference({
      name: 'SESSION_CAPABILITY_SECRET',
      reference: SESSION_SECRET_REF,
    });
    const ttlSeconds = Number(
      resolveRuntimeConfigReference({
        name: 'SESSION_CAPABILITY_TTL_SECONDS',
        reference: SESSION_TTL_REF,
      }),
    );
    const nowMs = 1_700_000_000_000;
    const sessionId = asSessionId('session-123');
    const token = createSessionCapabilityToken(
      {
        sessionId,
        nowMs,
        ttlSeconds,
      },
      secret,
    );

    expect(verifySessionCapabilityToken(token, SESSION_SECRET, { sessionId, nowMs }).ok).toBe(true);
    expect(() => encryptVoteSecret('0x' + '1'.repeat(64))).not.toThrow();
    expect(ssmSend).toHaveBeenCalledWith(
      expect.objectContaining({ input: { Name: SESSION_TTL_REF, WithDecryption: true } }),
    );
    expect(ssmSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ input: { Name: SESSION_SECRET_REF, WithDecryption: true } }),
    );
    expect(secretsSend).toHaveBeenCalledWith(expect.objectContaining({ input: { SecretId: SESSION_SECRET_REF } }));
  });

  it('does not satisfy a foundation Secrets Manager secret ref from a colliding SSM parameter', async () => {
    const ssmSend = vi.fn(async (command: { input?: { Name?: string } }) => {
      await Promise.resolve();
      if (command.input?.Name === SESSION_SECRET_REF) {
        return { Parameter: { Value: 'stale-ssm-session-secret' } };
      }
      if (command.input?.Name === SESSION_TTL_REF) {
        return { Parameter: { Value: '120' } };
      }
      throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
    });
    const secretsSend = vi.fn(async () => {
      await Promise.resolve();
      throw Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
    });

    await expect(
      loadAwsRuntimeConfigReferences({
        profile: activeTargetProfile,
        env: targetEnv(),
        ssmClient: { send: ssmSend },
        secretsManagerClient: { send: secretsSend },
      }),
    ).rejects.toThrow(`${SESSION_SECRET_REF} was not found in Secrets Manager.`);
    expect(ssmSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ input: { Name: SESSION_SECRET_REF, WithDecryption: true } }),
    );
    expect(secretsSend).toHaveBeenCalledWith(expect.objectContaining({ input: { SecretId: SESSION_SECRET_REF } }));
  });

  it.each(nonTurnstileEntrypoints)(
    'loads only %s references so unrelated missing Turnstile config does not block it',
    async (entrypoint) => {
      const env: NodeJS.ProcessEnv = {
        ...targetEnv(),
        TURNSTILE_SECRET_KEY_REF: '/stark-ballot-simulator/stark-dev/develop/app/secrets/missing-turnstile-secret',
      };
      const send = vi.fn(async (command: { input?: { Name?: string; SecretId?: string } }) => {
        await Promise.resolve();
        const reference = command.input?.Name ?? command.input?.SecretId;
        switch (reference) {
          case undefined:
            throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
          case SESSION_SECRET_REF:
            return { SecretString: SESSION_SECRET };
          case VOTE_SECRET_REF:
            return { SecretString: VOTE_SECRET };
          case SESSION_TTL_REF:
            return { Parameter: { Value: '120' } };
          case ORIGIN_VERIFY_HEADER_REF:
            return { SecretString: ORIGIN_VERIFY_HEADER };
          case LOG_IP_HASH_SALT_REF:
            return { SecretString: LOG_IP_HASH_SALT };
          default:
            throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
        }
      });

      await expect(
        ensureAwsRuntimeConfigReferencesLoaded(entrypoint, {
          profile: activeTargetProfile,
          env,
          ssmClient: { send },
          secretsManagerClient: { send },
        }),
      ).resolves.toBeUndefined();
      expect(send).not.toHaveBeenCalledWith(
        expect.objectContaining({ input: { Name: env['TURNSTILE_SECRET_KEY_REF'] } }),
      );
      expect(env['LOG_IP_HASH_SALT']).toBe(LOG_IP_HASH_SALT);
      expect(env['EXPECTED_ORIGIN_VERIFY_HEADER']).toBe(ORIGIN_VERIFY_HEADER);
    },
  );

  it('loads only the observability salt for semaphore_janitor', async () => {
    const env: NodeJS.ProcessEnv = {
      ...targetEnv(),
      TURNSTILE_SECRET_KEY_REF: '/stark-ballot-simulator/stark-dev/develop/app/secrets/missing-turnstile-secret',
    };
    const send = vi.fn(async (command: { input?: { SecretId?: string } }) => {
      await Promise.resolve();
      if (command.input?.SecretId === LOG_IP_HASH_SALT_REF) {
        return { SecretString: LOG_IP_HASH_SALT };
      }
      throw Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
    });

    await expect(
      loadAwsRuntimeConfigReferencesForEntrypoint('semaphore_janitor', {
        profile: activeTargetProfile,
        env,
        ssmClient: { send },
        secretsManagerClient: { send },
      }),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ input: { SecretId: LOG_IP_HASH_SALT_REF } }));
    expect(env['LOG_IP_HASH_SALT']).toBe(LOG_IP_HASH_SALT);
  });

  it('rejects a public API Turnstile reference changed after profile resolution', async () => {
    const env: NodeJS.ProcessEnv = {
      ...targetEnv(),
      TURNSTILE_SECRET_KEY_REF: '/stark-ballot-simulator/stark-dev/develop/app/secrets/missing-turnstile-secret',
    };
    const send = vi.fn(async (command: { input?: { Name?: string; SecretId?: string } }) => {
      await Promise.resolve();
      const reference = command.input?.Name ?? command.input?.SecretId;
      switch (reference) {
        case undefined:
          throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
        case SESSION_SECRET_REF:
          return { SecretString: SESSION_SECRET };
        case VOTE_SECRET_REF:
          return { SecretString: VOTE_SECRET };
        case SESSION_TTL_REF:
          return { Parameter: { Value: '120' } };
        case ORIGIN_VERIFY_HEADER_REF:
          return { SecretString: ORIGIN_VERIFY_HEADER };
        case LOG_IP_HASH_SALT_REF:
          return { SecretString: LOG_IP_HASH_SALT };
        default:
          throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
      }
    });

    const invalidNameCollector = {
      add: vi.fn(),
    };
    const resolutionError = await ensureAwsRuntimeConfigReferencesLoaded('public_api', {
      profile: activeTargetProfile,
      env,
      ssmClient: { send },
      secretsManagerClient: { send },
      invalidNameCollector,
    }).catch((error: unknown) => error);

    expect(resolutionError).toBeInstanceOf(Error);
    expect((resolutionError as Error).message).toBe(
      'TURNSTILE_SECRET_KEY_REF must match the reference captured by the runtime profile.',
    );
    expect(invalidNameCollector.add).toHaveBeenCalledTimes(1);
    expect(invalidNameCollector.add).toHaveBeenCalledWith('TURNSTILE_SECRET_KEY_REF');
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['active', activeTargetProfile],
    ['quiesced', quiescedTargetProfile],
  ] as const)('preloads references for the injected %s target profile', async (_name, profile) => {
    const env: NodeJS.ProcessEnv = {
      ...targetEnv(),
      RUNTIME_PROFILE: 'local-demo',
    };
    const send = vi.fn(async (command: { input?: { SecretId?: string } }) => {
      await Promise.resolve();
      if (command.input?.SecretId === LOG_IP_HASH_SALT_REF) {
        return { SecretString: LOG_IP_HASH_SALT };
      }
      throw Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
    });

    await ensureAwsRuntimeConfigReferencesLoaded('semaphore_janitor', {
      profile,
      env,
      ssmClient: { send },
      secretsManagerClient: { send },
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(env['LOG_IP_HASH_SALT']).toBe(LOG_IP_HASH_SALT);
  });

  it('skips reference preloading for an injected local profile even when the environment names a target profile', async () => {
    const send = vi.fn();

    await ensureAwsRuntimeConfigReferencesLoaded('semaphore_janitor', {
      profile: localProfile,
      env: targetEnv(),
      ssmClient: { send },
      secretsManagerClient: { send },
    });

    expect(send).not.toHaveBeenCalled();
  });

  it('rejects direct AWS reference loading for a local runtime profile', async () => {
    await expect(
      loadAwsRuntimeConfigReferences({
        profile: localProfile,
        env: targetEnv(),
      }),
    ).rejects.toThrow('AWS runtime config references require a target AWS runtime profile');
  });
});
