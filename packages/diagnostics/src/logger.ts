/**
 * Lightweight logger wrapper with level control.
 */
import { getLogContext, getLogContextLevel } from './requestLogContext';
import { LOG_LEVELS, isLogLevel, type LogLevel } from './loggerTypes';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

export type { LogLevel } from './loggerTypes';

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

type LogFormat = 'json' | 'text';

export interface LoggerRuntimeConfig {
  level?: LogLevel;
  format?: LogFormat;
  serviceName?: string;
  envName?: string;
  includeStack?: boolean;
}

let runtimeConfig: Required<LoggerRuntimeConfig> = {
  level: 'debug',
  format: 'text',
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

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (value instanceof Error) {
    return false;
  }
  return Object.prototype.toString.call(value) === '[object Object]';
};

const sanitizeError = (error: Error): { name: string; message: string; stack?: string } => {
  const payload: { name: string; message: string; stack?: string } = {
    name: error.name,
    ...omitUndefinedProperties({ message: error.message }),
  };
  if (runtimeConfig.includeStack) {
    if (error.stack !== undefined) {
      payload.stack = error.stack;
    }
  }
  return payload;
};

const extractLogArgs = (args: unknown[]): { message?: string; fields: Record<string, unknown>; error?: Error } => {
  const fields: Record<string, unknown> = {};
  let message: string | undefined;
  let error: Error | undefined;
  const extra: unknown[] = [];

  for (const arg of args) {
    if (typeof arg === 'string' && !message) {
      message = arg;
      continue;
    }
    if (arg instanceof Error && !error) {
      error = arg;
      continue;
    }
    if (isPlainObject(arg)) {
      Object.assign(fields, arg);
      continue;
    }
    extra.push(arg);
  }

  if (extra.length > 0) {
    fields['extra'] = extra;
  }

  return {
    ...omitUndefinedProperties({ message, error }),
    fields,
  };
};

const compact = <T extends Record<string, unknown>>(value: T): T => {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
};

const buildJsonPayload = (level: LogLevel, args: unknown[]): string => {
  const context = getLogContext();
  const { message, fields, error } = extractLogArgs(args);
  const {
    message: fieldMessage,
    event,
    request_id: fieldRequestId,
    requestId: fieldRequestIdAlias,
    service: fieldService,
    env: fieldEnv,
    http: fieldHttp,
    ...restFields
  } = fields;

  const resolvedMessage =
    message ??
    (typeof fieldMessage === 'string' ? fieldMessage : undefined) ??
    (typeof event === 'string' ? event : 'log');
  const resolvedRequestId =
    (fieldRequestId as string | undefined) ?? (fieldRequestIdAlias as string | undefined) ?? context?.requestId;
  const resolvedService = (fieldService as string | undefined) ?? context?.service ?? resolveServiceName();
  const resolvedEnv = (fieldEnv as string | undefined) ?? context?.env ?? resolveEnvName();
  const mergedHttp = compact({
    ...(context?.http ?? {}),
    ...(isPlainObject(fieldHttp) ? fieldHttp : {}),
  });

  const payload = compact({
    ts: new Date().toISOString(),
    level,
    message: resolvedMessage,
    event: typeof event === 'string' ? event : undefined,
    env: resolvedEnv,
    service: resolvedService,
    request_id: resolvedRequestId,
    http: Object.keys(mergedHttp).length > 0 ? mergedHttp : undefined,
    ...(error ? { error: sanitizeError(error) } : {}),
    ...restFields,
  });

  return JSON.stringify(payload);
};

const writeLog = (level: LogLevel, args: unknown[]): void => {
  if (!shouldLog(level)) {
    return;
  }
  const format = runtimeConfig.format;
  const message = format === 'json' ? buildJsonPayload(level, args) : undefined;

  if (level === 'debug') {
    return message ? console.debug(message) : console.debug(...args);
  }
  if (level === 'info') {
    return message ? console.log(message) : console.log(...args);
  }
  if (level === 'warn') {
    return message ? console.warn(message) : console.warn(...args);
  }
  return message ? console.error(message) : console.error(...args);
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
