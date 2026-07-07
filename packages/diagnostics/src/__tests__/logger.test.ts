import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import type { Logger, LoggerRuntimeConfig } from '../logger';

const withLogger = async (config: LoggerRuntimeConfig, fn: (logger: Logger) => void | Promise<void>): Promise<void> => {
  vi.resetModules();

  const { configureLogger, logger } = await import('../logger');
  configureLogger(config);

  try {
    await fn(logger);
  } finally {
    vi.resetModules();
  }
};

describe('logger', () => {
  let debugSpy: MockInstance<typeof console.debug>;
  let logSpy: MockInstance<typeof console.log>;
  let warnSpy: MockInstance<typeof console.warn>;
  let errorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    debugSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    vi.resetModules();
  });

  it('defaults to debug in non-production', async () => {
    await withLogger({ level: 'debug' }, (logger) => {
      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');
    });

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('defaults to info in production', async () => {
    await withLogger({ level: 'info' }, (logger) => {
      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');
    });

    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('respects LOG_LEVEL=warn', async () => {
    await withLogger({ level: 'warn' }, (logger) => {
      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');
    });

    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('respects LOG_LEVEL=silent', async () => {
    await withLogger({ level: 'silent' }, (logger) => {
      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');
    });

    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('uses request-scoped log level when present', async () => {
    await withLogger({ level: 'info' }, async (logger) => {
      const { runWithLogContext } = await import('../requestLogContext');

      runWithLogContext({ level: 'debug' }, () => {
        logger.debug('debug');
      });
    });

    expect(debugSpy).toHaveBeenCalledTimes(1);
  });

  it('does not leak request-scoped level outside the context', async () => {
    await withLogger({ level: 'info' }, async (logger) => {
      const { runWithLogContext } = await import('../requestLogContext');

      runWithLogContext({ level: 'debug' }, () => {
        logger.debug('inside');
      });

      logger.debug('outside');
    });

    expect(debugSpy).toHaveBeenCalledTimes(1);
  });

  it('emits JSON logs with context when LOG_FORMAT=json', async () => {
    await withLogger({ level: 'info', format: 'json' }, async (logger) => {
      const { runWithLogContext } = await import('../requestLogContext');

      runWithLogContext(
        {
          level: 'info',
          requestId: 'req-123',
          env: 'main',
          service: 'public-api',
          http: { method: 'GET', path: '/api/verify' },
        },
        () => {
          logger.info('request completed', {
            event: 'http_request',
            http: { status: 200 },
          });
        },
      );
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const calls = logSpy.mock.calls as Array<unknown[]>;
    const payload = calls[0]?.[0];
    expect(typeof payload).toBe('string');
    const parsed = parseJsonObject(payload);
    const http = getRecord(parsed['http']);
    expect(parsed['level']).toBe('info');
    expect(parsed['message']).toBe('request completed');
    expect(parsed['event']).toBe('http_request');
    expect(parsed['request_id']).toBe('req-123');
    expect(parsed['env']).toBe('main');
    expect(parsed['service']).toBe('public-api');
    expect(http?.['method']).toBe('GET');
    expect(http?.['path']).toBe('/api/verify');
    expect(http?.['status']).toBe(200);
  });
});

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return getRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
