import { logger as safeLogger } from '@stark-ballot/diagnostics/logger';

type LogPayload = Record<string, unknown>;

function emit(level: 'debug' | 'info' | 'warn' | 'error', message: string, payload?: unknown): void {
  if (level === 'debug' && process.env['DEBUG_ZKVM'] !== '1') {
    return;
  }
  const args = payload === undefined ? [message] : [message, payload as LogPayload];
  safeLogger[level](...args);
}

export const logger = {
  debug: (message: string, payload?: unknown): void => emit('debug', message, payload),
  info: (message: string, payload?: unknown): void => emit('info', message, payload),
  warn: (message: string, payload?: unknown): void => emit('warn', message, payload),
  error: (message: string, payload?: unknown): void => emit('error', message, payload),
};
