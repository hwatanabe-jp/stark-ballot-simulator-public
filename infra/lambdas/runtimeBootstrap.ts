import { configureLogger, logger, parseLogFormat, parseLogLevel } from '@stark-ballot/diagnostics/logger';
import { RuntimeConfigValidationError } from '@stark-ballot/runtime-config/env/configValidationError';

export type RuntimeConfigName = Uppercase<string>;
export { RuntimeConfigValidationError };

export interface RuntimeConfigInvalidNameCollector {
  add(name: RuntimeConfigName): void;
}

interface RuntimeValidationStep {
  readonly validate: () => void | Promise<void>;
}

interface LambdaRuntimeBootstrapOptions {
  readonly serviceName: string;
  readonly resolveRuntimeReferences: (invalidNames: RuntimeConfigInvalidNameCollector) => Promise<void>;
  readonly validationSteps: readonly RuntimeValidationStep[];
  readonly env?: NodeJS.ProcessEnv;
}

function createInvalidNameCollector(): {
  readonly collector: RuntimeConfigInvalidNameCollector;
  readonly names: RuntimeConfigName[];
} {
  const names: RuntimeConfigName[] = [];
  return {
    collector: {
      add(name) {
        if (!names.includes(name)) {
          names.push(name);
        }
      },
    },
    names,
  };
}

function configureSecretFreeLogger(serviceName: string, env: NodeJS.ProcessEnv): void {
  const targetRuntime = env['TARGET_AWS_RUNTIME'] === '1';
  const deploymentId = env['DEPLOYMENT_ID']?.trim();
  const appSourceSha = env['APP_SOURCE_SHA']?.trim();
  const deployMode = env['DEPLOY_MODE']?.trim();
  configureLogger({
    format: targetRuntime ? 'json' : parseLogFormat(env['LOG_FORMAT'], 'text'),
    jsonOutputMode: targetRuntime ? 'lambda-native' : 'serialized',
    level: parseLogLevel(env['LOG_LEVEL'], 'info'),
    serviceName,
    envName: env['RUNTIME_DEPLOYMENT_ENV']?.trim() || env['NODE_ENV']?.trim() || 'unknown',
    includeStack: true,
    ...(deploymentId && /^dep_[0-9a-f]{32}$/.test(deploymentId) ? { deploymentId } : {}),
    ...(appSourceSha && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(appSourceSha) ? { appSourceSha } : {}),
    ...(deployMode === 'normal' || deployMode === 'rollback' ? { deployMode } : {}),
  });
}

function emitConfigInvalid(invalidNames: readonly RuntimeConfigName[]): void {
  logger.error('Runtime configuration is invalid', {
    event: 'config_invalid',
    invalid_names: [...invalidNames],
  });
}

function sanitizedRuntimeConfigError(invalidNames: readonly RuntimeConfigName[]): RuntimeConfigValidationError {
  return new RuntimeConfigValidationError(invalidNames);
}

export async function bootstrapLambdaRuntime(options: LambdaRuntimeBootstrapOptions): Promise<void> {
  configureSecretFreeLogger(options.serviceName, options.env ?? process.env);

  const referenceInvalidNames = createInvalidNameCollector();
  try {
    await options.resolveRuntimeReferences(referenceInvalidNames.collector);
  } catch (error) {
    if (referenceInvalidNames.names.length > 0) {
      const sanitizedError = sanitizedRuntimeConfigError(referenceInvalidNames.names);
      emitConfigInvalid(sanitizedError.invalidNames);
      throw sanitizedError;
    }
    throw error;
  }

  for (const step of options.validationSteps) {
    try {
      await step.validate();
    } catch (error) {
      if (error instanceof RuntimeConfigValidationError) {
        const sanitizedError = sanitizedRuntimeConfigError(error.invalidNames);
        emitConfigInvalid(sanitizedError.invalidNames);
        throw sanitizedError;
      }
      throw error;
    }
  }
}
