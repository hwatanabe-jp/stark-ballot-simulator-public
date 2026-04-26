export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

export const isLogLevel = (value: string): value is LogLevel =>
  value === 'debug' || value === 'info' || value === 'warn' || value === 'error' || value === 'silent';
