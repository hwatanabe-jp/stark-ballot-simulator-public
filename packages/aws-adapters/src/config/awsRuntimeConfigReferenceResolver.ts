import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  installStaticRuntimeConfigReferenceResolver,
  type RuntimeConfigReferenceName,
} from '@stark-ballot/runtime-config/env/runtimeConfigReferences';

export type AwsRuntimeReferenceEnvName =
  | 'SESSION_CAPABILITY_SECRET_REF'
  | 'VOTE_SECRET_ENCRYPTION_KEY_REF'
  | 'SESSION_CAPABILITY_TTL_SECONDS_REF'
  | 'TURNSTILE_SECRET_KEY_REF'
  | 'LOG_IP_HASH_SALT_REF'
  | 'EXPECTED_ORIGIN_VERIFY_HEADER_REF';

export type AwsRuntimeEntrypoint =
  'public_api' | 'finalization_writer' | 'proof_dispatcher' | 'verification_worker' | 'semaphore_janitor';

interface AwsRuntimeReferenceDescriptor {
  envName: AwsRuntimeReferenceEnvName;
  name: RuntimeConfigReferenceName;
  service: 'secretsmanager' | 'ssm';
  targetEnvName?: string;
}

interface AwsSendClient {
  send(command: object): Promise<unknown>;
}

export interface AwsRuntimeConfigInvalidNameCollector {
  add(name: AwsRuntimeReferenceEnvName): void;
}

interface AwsRuntimeConfigReferenceResolverOptions {
  env?: NodeJS.ProcessEnv;
  ssmClient?: AwsSendClient;
  secretsManagerClient?: AwsSendClient;
  invalidNameCollector?: AwsRuntimeConfigInvalidNameCollector;
}

const TARGET_RUNTIME_REFERENCES: readonly AwsRuntimeReferenceDescriptor[] = [
  { envName: 'SESSION_CAPABILITY_SECRET_REF', name: 'SESSION_CAPABILITY_SECRET', service: 'secretsmanager' },
  { envName: 'VOTE_SECRET_ENCRYPTION_KEY_REF', name: 'VOTE_SECRET_ENCRYPTION_KEY', service: 'secretsmanager' },
  { envName: 'SESSION_CAPABILITY_TTL_SECONDS_REF', name: 'SESSION_CAPABILITY_TTL_SECONDS', service: 'ssm' },
  { envName: 'TURNSTILE_SECRET_KEY_REF', name: 'TURNSTILE_SECRET_KEY', service: 'secretsmanager' },
  {
    envName: 'EXPECTED_ORIGIN_VERIFY_HEADER_REF',
    name: 'EXPECTED_ORIGIN_VERIFY_HEADER',
    service: 'secretsmanager',
    targetEnvName: 'EXPECTED_ORIGIN_VERIFY_HEADER',
  },
  {
    envName: 'LOG_IP_HASH_SALT_REF',
    name: 'LOG_IP_HASH_SALT',
    service: 'secretsmanager',
    targetEnvName: 'LOG_IP_HASH_SALT',
  },
];

const TARGET_RUNTIME_REFERENCES_BY_ENTRYPOINT: Record<AwsRuntimeEntrypoint, readonly AwsRuntimeReferenceEnvName[]> = {
  public_api: [
    'SESSION_CAPABILITY_SECRET_REF',
    'VOTE_SECRET_ENCRYPTION_KEY_REF',
    'SESSION_CAPABILITY_TTL_SECONDS_REF',
    'TURNSTILE_SECRET_KEY_REF',
    'EXPECTED_ORIGIN_VERIFY_HEADER_REF',
    'LOG_IP_HASH_SALT_REF',
  ],
  finalization_writer: [
    'SESSION_CAPABILITY_SECRET_REF',
    'VOTE_SECRET_ENCRYPTION_KEY_REF',
    'SESSION_CAPABILITY_TTL_SECONDS_REF',
    'EXPECTED_ORIGIN_VERIFY_HEADER_REF',
    'LOG_IP_HASH_SALT_REF',
  ],
  proof_dispatcher: [
    'SESSION_CAPABILITY_SECRET_REF',
    'VOTE_SECRET_ENCRYPTION_KEY_REF',
    'SESSION_CAPABILITY_TTL_SECONDS_REF',
    'EXPECTED_ORIGIN_VERIFY_HEADER_REF',
    'LOG_IP_HASH_SALT_REF',
  ],
  verification_worker: [
    'SESSION_CAPABILITY_SECRET_REF',
    'VOTE_SECRET_ENCRYPTION_KEY_REF',
    'SESSION_CAPABILITY_TTL_SECONDS_REF',
    'EXPECTED_ORIGIN_VERIFY_HEADER_REF',
    'LOG_IP_HASH_SALT_REF',
  ],
  semaphore_janitor: ['LOG_IP_HASH_SALT_REF'],
};

let preloadPromise: Promise<void> | undefined;
const entrypointPreloadPromises = new Map<AwsRuntimeEntrypoint, Promise<void>>();

function getStringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : undefined;
}

function getNestedStringProperty(value: unknown, first: string, second: string): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return getStringProperty((value as Record<string, unknown>)[first], second);
}

function getBinarySecretProperty(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)['SecretBinary'];
  if (candidate instanceof Uint8Array) {
    return Buffer.from(candidate).toString('base64');
  }
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : undefined;
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as Record<string, unknown>;
  return record['name'] === 'ParameterNotFound' || record['name'] === 'ResourceNotFoundException';
}

function isSsmReference(reference: string): boolean {
  return reference.startsWith('/') || reference.startsWith('arn:aws:ssm:');
}

function isSecretsManagerReference(reference: string): boolean {
  return reference.startsWith('/') || reference.startsWith('arn:aws:secretsmanager:');
}

async function resolveFromSsm(client: AwsSendClient, reference: string): Promise<string | undefined> {
  try {
    const result = await client.send(
      new GetParameterCommand({
        Name: reference,
        WithDecryption: true,
      }),
    );
    return getNestedStringProperty(result, 'Parameter', 'Value');
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function resolveFromSecretsManager(client: AwsSendClient, reference: string): Promise<string | undefined> {
  try {
    const result = await client.send(
      new GetSecretValueCommand({
        SecretId: reference,
      }),
    );
    return getStringProperty(result, 'SecretString') ?? getBinarySecretProperty(result);
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function resolveAwsRuntimeReference(
  descriptor: AwsRuntimeReferenceDescriptor,
  reference: string,
  ssmClient: AwsSendClient,
  secretsManagerClient: AwsSendClient,
): Promise<string> {
  if (descriptor.service === 'ssm' && isSsmReference(reference)) {
    const value = await resolveFromSsm(ssmClient, reference);
    if (value) {
      return value;
    }
  }

  if (descriptor.service === 'secretsmanager' && isSecretsManagerReference(reference)) {
    const value = await resolveFromSecretsManager(secretsManagerClient, reference);
    if (value) {
      return value;
    }
  }

  const serviceName = descriptor.service === 'ssm' ? 'SSM Parameter Store' : 'Secrets Manager';
  throw new Error(`${reference} was not found in ${serviceName}.`);
}

export async function loadAwsRuntimeConfigReferences(
  options: AwsRuntimeConfigReferenceResolverOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const ssmClient = options.ssmClient ?? new SSMClient({});
  const secretsManagerClient = options.secretsManagerClient ?? new SecretsManagerClient({});
  const values = new Map<string, string>();

  for (const descriptor of TARGET_RUNTIME_REFERENCES) {
    const reference = env[descriptor.envName]?.trim();
    if (!reference) {
      continue;
    }
    let resolvedValue: string;
    try {
      resolvedValue = await resolveAwsRuntimeReference(descriptor, reference, ssmClient, secretsManagerClient);
    } catch (error) {
      options.invalidNameCollector?.add(descriptor.envName);
      throw error;
    }
    values.set(reference, resolvedValue);
    if (descriptor.targetEnvName) {
      env[descriptor.targetEnvName] = resolvedValue;
    }
  }

  installStaticRuntimeConfigReferenceResolver(values);
}

export async function loadAwsRuntimeConfigReferencesForEntrypoint(
  entrypoint: AwsRuntimeEntrypoint,
  options: AwsRuntimeConfigReferenceResolverOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const allowedReferences = new Set(TARGET_RUNTIME_REFERENCES_BY_ENTRYPOINT[entrypoint]);
  const filteredEnv = {
    ...env,
    ...Object.fromEntries(
      TARGET_RUNTIME_REFERENCES.filter((descriptor) => !allowedReferences.has(descriptor.envName)).map((descriptor) => [
        descriptor.envName,
        '',
      ]),
    ),
  };
  await loadAwsRuntimeConfigReferences({
    ...options,
    env: filteredEnv,
  });
  for (const descriptor of TARGET_RUNTIME_REFERENCES) {
    if (descriptor.targetEnvName && filteredEnv[descriptor.targetEnvName]) {
      env[descriptor.targetEnvName] = filteredEnv[descriptor.targetEnvName];
    }
  }
}

export async function ensureAwsRuntimeConfigReferencesLoaded(
  entrypoint?: AwsRuntimeEntrypoint,
  options: AwsRuntimeConfigReferenceResolverOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  if (env['TARGET_AWS_RUNTIME'] !== '1') {
    return;
  }

  if (!entrypoint) {
    preloadPromise ??= loadAwsRuntimeConfigReferences(options).catch((error: unknown) => {
      preloadPromise = undefined;
      throw error;
    });
    await preloadPromise;
    return;
  }

  let entrypointPromise = entrypointPreloadPromises.get(entrypoint);
  if (!entrypointPromise) {
    entrypointPromise = loadAwsRuntimeConfigReferencesForEntrypoint(entrypoint, options).catch((error: unknown) => {
      entrypointPreloadPromises.delete(entrypoint);
      throw error;
    });
    entrypointPreloadPromises.set(entrypoint, entrypointPromise);
  }
  await entrypointPromise;
}

export function resetAwsRuntimeConfigReferenceResolverForTests(): void {
  preloadPromise = undefined;
  entrypointPreloadPromises.clear();
}
