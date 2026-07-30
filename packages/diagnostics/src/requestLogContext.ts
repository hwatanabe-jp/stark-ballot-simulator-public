import { AsyncLocalStorage } from 'node:async_hooks';
import type { LogLevel } from './loggerTypes';

export interface LogContext {
  level?: LogLevel;
  requestId?: string;
  service?: string;
  env?: string;
  http?: {
    method?: string;
    path?: string;
    source_ip_hash?: string;
  };
}

const storage = new AsyncLocalStorage<LogContext>();

export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getLogContextLevel(): LogLevel | undefined {
  return storage.getStore()?.level;
}

export function getLogContext(): LogContext | undefined {
  return storage.getStore();
}
