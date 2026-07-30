/**
 * Lightweight logger wrapper with level control.
 */
import { getLogContext, getLogContextLevel } from './requestLogContext';
import { LOG_LEVELS, isLogLevel, type LogLevel } from './loggerTypes';
import {
  MAX_LOG_BYTES,
  SAFE_LOG_FALLBACK_RECORD,
  createLogSanitizer,
  sanitizeLogString,
  serializeBoundedLogValue,
  type LogSanitizer,
  type SafeLogObject,
  type SafeLogValue,
} from './safeLogPayload';

export type { LogLevel } from './loggerTypes';

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

type LogFormat = 'json' | 'text';
type JsonOutputMode = 'lambda-native' | 'serialized';

export interface LoggerRuntimeConfig {
  level?: LogLevel;
  format?: LogFormat;
  jsonOutputMode?: JsonOutputMode;
  serviceName?: string;
  envName?: string;
  includeStack?: boolean;
  deploymentId?: string;
  appSourceSha?: string;
  deployMode?: 'normal' | 'rollback';
}

interface ResolvedLoggerRuntimeConfig {
  level: LogLevel;
  format: LogFormat;
  jsonOutputMode: JsonOutputMode;
  serviceName: string;
  envName: string;
  includeStack: boolean;
  deploymentId?: string;
  appSourceSha?: string;
  deployMode?: 'normal' | 'rollback';
}

let runtimeConfig: ResolvedLoggerRuntimeConfig = {
  level: 'debug',
  format: 'text',
  jsonOutputMode: 'serialized',
  serviceName: 'app',
  envName: 'unknown',
  includeStack: false,
};

export function configureLogger(config: LoggerRuntimeConfig): void {
  runtimeConfig = {
    ...runtimeConfig,
    ...config,
  };
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  const normalized = value?.toLowerCase();
  return normalized && isLogLevel(normalized) ? normalized : fallback;
}

export function parseLogFormat(value: string | undefined, fallback: LogFormat): LogFormat {
  const normalized = value?.toLowerCase();
  return normalized === 'json' || normalized === 'text' ? normalized : fallback;
}

const resolveActiveLevel = (): LogLevel => getLogContextLevel() ?? runtimeConfig.level;

const shouldLog = (level: LogLevel): boolean => LOG_LEVELS[level] >= LOG_LEVELS[resolveActiveLevel()];

const resolveServiceName = (): string => {
  return runtimeConfig.serviceName;
};

const resolveEnvName = (): string => {
  return runtimeConfig.envName;
};

const createSafeLogObject = (): SafeLogObject => Object.create(null) as SafeLogObject;
const RESERVED_ENVELOPE_FIELDS = new Set([
  'app_source_sha',
  'deploy_mode',
  'deployment_id',
  'env',
  'error',
  'event',
  'http',
  'level',
  'message',
  'requestId',
  'request_id',
  'service',
  'ts',
]);
const MAX_ARGUMENTS_TO_CLASSIFY = 64;

const isPlainObject = (value: unknown): value is object => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (value instanceof Error) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const asSafeObject = (value: SafeLogValue | undefined): SafeLogObject | undefined => {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
};

const extractLogArgs = (
  args: unknown[],
  sanitizer: LogSanitizer,
): { message?: string; fields: SafeLogObject; error?: SafeLogObject } => {
  const fields = createSafeLogObject();
  let message: string | undefined;
  let error: SafeLogObject | undefined;
  const extra: SafeLogValue[] = [];

  const prioritizedArgs = args.slice(0, MAX_ARGUMENTS_TO_CLASSIFY).map((arg, index) => {
    let priority = 3;
    if (typeof arg === 'string') {
      priority = 0;
    } else if (arg instanceof Error) {
      priority = 1;
    } else if (isPlainObject(arg)) {
      const hasCanonicalField = ['event', 'error', 'message'].some(
        (key) => Object.getOwnPropertyDescriptor(arg, key) !== undefined,
      );
      priority = hasCanonicalField ? 2 : 3;
    }
    return { arg, index, priority };
  });
  prioritizedArgs.sort((left, right) => left.priority - right.priority || left.index - right.index);

  for (const { arg } of prioritizedArgs) {
    if (!sanitizer.hasCapacity()) {
      break;
    }
    const sanitized = sanitizer.sanitize(arg, { includeErrorStack: runtimeConfig.includeStack });
    if (sanitized === undefined) {
      continue;
    }
    if (typeof arg === 'string' && !message && typeof sanitized === 'string') {
      message = sanitized;
      continue;
    }
    if (arg instanceof Error && !error) {
      error = asSafeObject(sanitized);
      continue;
    }
    if (isPlainObject(arg)) {
      const object = asSafeObject(sanitized);
      if (object) {
        Object.assign(fields, object);
      }
      continue;
    }
    extra.push(sanitized);
  }

  if (extra.length > 0) {
    fields['extra'] = extra;
  }

  return { ...(message !== undefined ? { message } : {}), ...(error ? { error } : {}), fields };
};

const compact = (value: Record<string, SafeLogValue | undefined>): SafeLogObject => {
  const output = createSafeLogObject();
  for (const [key, field] of Object.entries(value)) {
    if (field !== undefined) {
      output[key] = field;
    }
  }
  return output;
};

const getStringField = (value: SafeLogObject | undefined, key: string): string | undefined => {
  const field = value?.[key];
  return typeof field === 'string' ? field : undefined;
};

const buildJsonPayload = (level: LogLevel, args: unknown[], includeContext: boolean): string => {
  const sanitizer = createLogSanitizer();
  const rawContext = includeContext ? getLogContext() : undefined;
  const context = rawContext === undefined ? undefined : asSafeObject(sanitizer.sanitize(rawContext));
  const { message, fields, error } = extractLogArgs(args, sanitizer);
  const fieldMessage = getStringField(fields, 'message');
  const event = getStringField(fields, 'event');
  const fieldHttp = asSafeObject(fields['http']);
  const fieldError = fields['error'];
  const contextHttp = asSafeObject(context?.['http']);
  const restFields = createSafeLogObject();
  for (const [key, field] of Object.entries(fields)) {
    if (!RESERVED_ENVELOPE_FIELDS.has(key)) {
      restFields[key] = field;
    }
  }

  const resolvedMessage = message ?? fieldMessage ?? event ?? 'log';
  const resolvedRequestId = getStringField(context, 'requestId');
  const resolvedService = sanitizeLogString(resolveServiceName());
  const resolvedEnv = sanitizeLogString(resolveEnvName());
  const mergedHttp = compact({
    ...(contextHttp ?? {}),
    ...(fieldHttp ?? {}),
  });

  const payload: SafeLogObject = compact({
    ts: new Date().toISOString(),
    level,
    message: resolvedMessage,
    event,
    env: resolvedEnv,
    service: resolvedService,
    deployment_id: runtimeConfig.deploymentId ? sanitizeLogString(runtimeConfig.deploymentId) : undefined,
    app_source_sha: runtimeConfig.appSourceSha ? sanitizeLogString(runtimeConfig.appSourceSha) : undefined,
    deploy_mode: runtimeConfig.deployMode ? sanitizeLogString(runtimeConfig.deployMode) : undefined,
    request_id: resolvedRequestId,
    http: Object.keys(mergedHttp).length > 0 ? mergedHttp : undefined,
    ...((error ?? fieldError) ? { error: error ?? fieldError } : {}),
    ...restFields,
  });

  return serializeBoundedLogValue(payload);
};

type LogOutput = string | SafeLogObject;

const toLambdaNativeJsonObject = (serialized: string): SafeLogObject => {
  const parsed = JSON.parse(serialized) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error('Bounded JSON log payload must be an object.');
  }
  return parsed as SafeLogObject;
};

const buildFallbackOutput = (format: LogFormat, jsonOutputMode: JsonOutputMode): LogOutput =>
  format === 'json' && jsonOutputMode === 'lambda-native'
    ? toLambdaNativeJsonObject(SAFE_LOG_FALLBACK_RECORD)
    : SAFE_LOG_FALLBACK_RECORD;

const buildLogOutput = (
  level: LogLevel,
  args: unknown[],
  format: LogFormat,
  jsonOutputMode: JsonOutputMode,
): LogOutput => {
  try {
    if (format === 'text' && args.length === 1 && typeof args[0] === 'string') {
      return sanitizeLogString(args[0]);
    }
    const json = buildJsonPayload(level, args, format === 'json');
    if (format === 'json') {
      return jsonOutputMode === 'lambda-native' ? toLambdaNativeJsonObject(json) : json;
    }
    if (json === SAFE_LOG_FALLBACK_RECORD) {
      return json;
    }
    const text = `[${level}] ${json}`;
    return Buffer.byteLength(text, 'utf8') <= MAX_LOG_BYTES ? text : SAFE_LOG_FALLBACK_RECORD;
  } catch {
    return buildFallbackOutput(format, jsonOutputMode);
  }
};

const emitLog = (level: LogLevel, message: LogOutput): void => {
  if (level === 'debug') {
    console.debug(message);
    return;
  }
  if (level === 'info') {
    console.log(message);
    return;
  }
  if (level === 'warn') {
    console.warn(message);
    return;
  }
  console.error(message);
};

const writeLog = (level: LogLevel, args: unknown[]): void => {
  try {
    if (!shouldLog(level)) {
      return;
    }
    emitLog(level, buildLogOutput(level, args, runtimeConfig.format, runtimeConfig.jsonOutputMode));
  } catch {
    try {
      emitLog(level, buildFallbackOutput(runtimeConfig.format, runtimeConfig.jsonOutputMode));
    } catch {
      // Logging is observational and must never interrupt the application path.
    }
  }
};

export const logger: Logger = {
  debug: (...args: unknown[]): void => {
    writeLog('debug', args);
  },
  info: (...args: unknown[]): void => {
    writeLog('info', args);
  },
  warn: (...args: unknown[]): void => {
    writeLog('warn', args);
  },
  error: (...args: unknown[]): void => {
    writeLog('error', args);
  },
};
