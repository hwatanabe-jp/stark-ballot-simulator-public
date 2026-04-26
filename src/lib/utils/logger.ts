/**
 * Lightweight logger wrapper with level control.
 */
import { getLogContext, getLogContextLevel } from '@/lib/utils/requestLogContext';
import { LOG_LEVELS, isLogLevel, type LogLevel } from '@/lib/utils/loggerTypes';

export type { LogLevel } from '@/lib/utils/loggerTypes';

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const resolveLogLevel = (): LogLevel => {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLevel && isLogLevel(envLevel)) {
    return envLevel;
  }
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
};

const defaultLevel = resolveLogLevel();

const resolveActiveLevel = (): LogLevel => getLogContextLevel() ?? defaultLevel;

const shouldLog = (level: LogLevel): boolean => LOG_LEVELS[level] >= LOG_LEVELS[resolveActiveLevel()];

type LogFormat = 'json' | 'text';

const resolveLogFormat = (): LogFormat => {
  const envFormat = process.env.LOG_FORMAT?.toLowerCase();
  if (envFormat === 'json' || envFormat === 'text') {
    return envFormat;
  }
  return process.env.NODE_ENV === 'production' ? 'json' : 'text';
};

const defaultFormat = resolveLogFormat();

const resolveActiveFormat = (): LogFormat => defaultFormat;

const resolveServiceName = (): string => {
  const service = process.env.LOG_SERVICE ?? process.env.SERVICE_NAME ?? process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (service && service.trim().length > 0) {
    return service.trim();
  }
  return 'app';
};

const resolveEnvName = (): string => {
  const candidates = [
    process.env.APP_ENV,
    process.env.NEXT_PUBLIC_APP_ENV,
    process.env.AMPLIFY_BRANCH,
    process.env.NODE_ENV,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return 'unknown';
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
    message: error.message,
  };
  if (process.env.LOG_INCLUDE_STACK === 'true') {
    payload.stack = error.stack;
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
    fields.extra = extra;
  }

  return { message, fields, error };
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
  const format = resolveActiveFormat();
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
