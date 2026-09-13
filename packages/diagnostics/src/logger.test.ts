import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import type { Logger, LoggerRuntimeConfig } from './logger';

const withLogger = async (config: LoggerRuntimeConfig, fn: (logger: Logger) => void | Promise<void>): Promise<void> => {
  vi.resetModules();

  const { configureLogger, logger } = await import('./logger');
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
      const { runWithLogContext } = await import('./requestLogContext');

      runWithLogContext({ level: 'debug' }, () => {
        logger.debug('debug');
      });
    });

    expect(debugSpy).toHaveBeenCalledTimes(1);
  });

  it('does not leak request-scoped level outside the context', async () => {
    await withLogger({ level: 'info' }, async (logger) => {
      const { runWithLogContext } = await import('./requestLogContext');

      runWithLogContext({ level: 'debug' }, () => {
        logger.debug('inside');
      });

      logger.debug('outside');
    });

    expect(debugSpy).toHaveBeenCalledTimes(1);
  });

  it('emits JSON logs with context when LOG_FORMAT=json', async () => {
    await withLogger({ level: 'info', format: 'json', serviceName: 'public-api', envName: 'main' }, async (logger) => {
      const { runWithLogContext } = await import('./requestLogContext');

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

  it('passes one bounded object to the Lambda native JSON logger', async () => {
    const rawSessionId = '550e8400-e29b-41d4-a716-446655440000';

    await withLogger(
      {
        level: 'info',
        format: 'json',
        jsonOutputMode: 'lambda-native',
        serviceName: 'public-api',
        envName: 'develop',
      },
      (logger) => {
        logger.info('request completed', {
          event: 'http_request',
          sessionId: rawSessionId,
          http: { status: 200 },
        });
      },
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
    const calls = logSpy.mock.calls as Array<unknown[]>;
    expect(calls[0]).toHaveLength(1);
    const payload = getRecord(calls[0]?.[0]);
    expect(payload).toMatchObject({
      level: 'info',
      message: 'request completed',
      event: 'http_request',
      service: 'public-api',
      env: 'develop',
    });
    expect(JSON.stringify(payload)).not.toContain(rawSessionId);
  });

  it('preserves sanitization and byte bounds in Lambda native JSON mode', async () => {
    const oversized = `${'x'.repeat(100_000)}END_OF_OVERSIZED_VALUE`;

    await withLogger(
      {
        level: 'info',
        format: 'json',
        jsonOutputMode: 'lambda-native',
      },
      (logger) => {
        expect(() => logger.info('bounded Lambda payload', { oversized })).not.toThrow();
      },
    );

    const calls = logSpy.mock.calls as Array<unknown[]>;
    const payload = getRecord(calls[0]?.[0]);
    const serialized = JSON.stringify(payload);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(serialized).not.toContain('END_OF_OVERSIZED_VALUE');
  });

  it('does not allow caller fields to replace reserved envelope values', async () => {
    const rawSessionId = '550e8400-e29b-41d4-a716-446655440000';

    await withLogger(
      {
        level: 'info',
        format: 'json',
        serviceName: 'runtime-service',
        envName: 'runtime-env',
      },
      async (logger) => {
        const { runWithLogContext } = await import('./requestLogContext');

        runWithLogContext(
          {
            requestId: 'trusted-request-id',
            service: 'context-service',
            env: 'context-env',
          },
          () => {
            logger.warn(
              'reserved envelope test',
              {
                ts: 'caller-controlled-time',
                level: 'error',
                error: { message: 'caller-controlled-error' },
                request_id: rawSessionId,
                requestId: 'caller-request-id',
                service: 'caller-service',
                env: 'caller-env',
              },
              new Error('standalone bounded error'),
            );
          },
        );
      },
    );

    const output = firstStringCall(warnSpy);
    const parsed = parseJsonObject(output);
    expect(parsed['level']).toBe('warn');
    expect(parsed['ts']).not.toBe('caller-controlled-time');
    expect(parsed['request_id']).toBe('trusted-request-id');
    expect(parsed['service']).toBe('runtime-service');
    expect(parsed['env']).toBe('runtime-env');
    expect(getRecord(parsed['error'])?.['message']).toBe('standalone bounded error');
    expect(output).not.toContain(rawSessionId);
    expect(output).not.toContain('caller-request-id');
    expect(output).not.toContain('caller-service');
    expect(output).not.toContain('caller-env');
    expect(output).not.toContain('context-service');
    expect(output).not.toContain('context-env');
  });

  it('never promotes caller request IDs without trusted request context', async () => {
    const rawSessionId = '550e8400-e29b-41d4-a716-446655440000';

    await withLogger(
      {
        level: 'info',
        format: 'json',
        serviceName: 'runtime-service',
        envName: 'runtime-env',
      },
      (logger) => {
        logger.info('unscoped reserved envelope test', {
          request_id: rawSessionId,
          requestId: 'caller-request-id',
          service: 'caller-service',
          env: 'caller-env',
        });
      },
    );

    const output = firstStringCall(logSpy);
    const parsed = parseJsonObject(output);
    expect(parsed).not.toHaveProperty('request_id');
    expect(parsed['service']).toBe('runtime-service');
    expect(parsed['env']).toBe('runtime-env');
    expect(output).not.toContain(rawSessionId);
    expect(output).not.toContain('caller-request-id');
    expect(output).not.toContain('caller-service');
    expect(output).not.toContain('caller-env');
  });

  it('stamps configured deployment authority on every JSON record and rejects caller overrides', async () => {
    await withLogger(
      {
        level: 'info',
        format: 'json',
        deploymentId: 'dep_0123456789abcdef0123456789abcdef',
        appSourceSha: 'a'.repeat(40),
        deployMode: 'rollback',
      },
      (logger) => {
        logger.info('deployment envelope', {
          deployment_id: 'dep_caller',
          app_source_sha: 'b'.repeat(40),
          deploy_mode: 'normal',
        });
      },
    );

    const parsed = parseJsonObject(firstStringCall(logSpy));
    expect(parsed['deployment_id']).toBe('dep_0123456789abcdef0123456789abcdef');
    expect(parsed['app_source_sha']).toBe('a'.repeat(40));
    expect(parsed['deploy_mode']).toBe('rollback');
  });

  it('omits deployment authority when it is not configured instead of emitting placeholders', async () => {
    await withLogger({ level: 'info', format: 'json' }, (logger) => {
      logger.info('local envelope');
    });

    const parsed = parseJsonObject(firstStringCall(logSpy));
    expect(parsed).not.toHaveProperty('deployment_id');
    expect(parsed).not.toHaveProperty('app_source_sha');
    expect(parsed).not.toHaveProperty('deploy_mode');
  });

  it('serializes circular, deep, wide, and oversized values without throwing or exceeding the log budget', async () => {
    const circular: Record<string, unknown> = { label: 'root' };
    circular['self'] = circular;
    const deep = {
      level1: {
        level2: {
          level3: {
            level4: {
              level5: {
                level6: {
                  level7: 'too-deep',
                },
              },
            },
          },
        },
      },
    };
    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`field_${index}`, index]));
    const oversized = `${'x'.repeat(100_000)}END_OF_OVERSIZED_VALUE`;

    await withLogger({ level: 'info', format: 'json' }, (logger) => {
      expect(() => logger.info('bounded payload', { circular, deep, wide, oversized, bigint: 1n })).not.toThrow();
    });

    const output = firstStringCall(logSpy);
    expect(() => {
      JSON.parse(output);
    }).not.toThrow();
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(output).toContain('[Circular]');
    expect(output).not.toContain('END_OF_OVERSIZED_VALUE');
    expect(output).not.toContain('too-deep');
  });

  it('bounds Error fields and scrubs secrets from arbitrary error text', async () => {
    const capability = `v1.${'a'.repeat(64)}.${'b'.repeat(64)}`;
    const error = new Error(
      `upload s3://private-bucket/sessions/raw-session/input.json failed with Bearer ${capability}${'x'.repeat(10_000)}`,
    );
    error.name = 'SensitiveError';
    error.stack = `Error: ${capability}\n${'stack-frame\n'.repeat(5_000)}`;

    await withLogger({ level: 'info', format: 'json', includeStack: true }, (logger) => {
      expect(() => logger.error('operation failed', error)).not.toThrow();
    });

    const output = firstStringCall(errorSpy);
    const parsed = parseJsonObject(output);
    const serializedError = getRecord(parsed['error']);
    expect(serializedError?.['name']).toBe('SensitiveError');
    expect(output).not.toContain('private-bucket');
    expect(output).not.toContain(capability);
    expect(output).not.toContain('stack-frame\nstack-frame\nstack-frame\nstack-frame');
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(32 * 1024);
  });

  it('independently bounds oversized non-sensitive Error fields', async () => {
    const error = new Error(`${'message-character'.repeat(1_000)}END_OF_ERROR_MESSAGE`);
    error.name = `${'ErrorName'.repeat(100)}END_OF_ERROR_NAME`;
    error.stack = `${'safe-stack-frame\n'.repeat(1_000)}END_OF_ERROR_STACK`;

    await withLogger({ level: 'info', format: 'json', includeStack: true }, (logger) => {
      logger.error('bounded non-sensitive error', error);
    });

    const parsed = parseJsonObject(firstStringCall(errorSpy));
    const serializedError = getRecord(parsed['error']);
    expect(serializedError?.['name']).toMatch(/\[Truncated\]$/);
    expect(serializedError?.['message']).toMatch(/\[Truncated\]$/);
    expect(serializedError?.['stack']).toMatch(/\[Truncated\]$/);
    expect(serializedError?.['name']).not.toContain('END_OF_ERROR_NAME');
    expect(serializedError?.['message']).not.toContain('END_OF_ERROR_MESSAGE');
    expect(serializedError?.['stack']).not.toContain('END_OF_ERROR_STACK');
  });

  it('scrubs denied keys and sensitive value shapes while preserving public telemetry names', async () => {
    const capability = `v1.${'a'.repeat(64)}.${'b'.repeat(64)}`;
    const jwt = `${'a'.repeat(24)}.${'b'.repeat(24)}.${'c'.repeat(24)}`;
    const rawLocatorSessionId = 'raw-locator-session-id';
    const rawSessionIdentifier = 'raw-session-identifier';
    const rawIp = '198.51.100.42';
    const rawForwardedIp = '203.0.113.8';
    const rawRemoteIp = '203.0.113.9';
    const callbackTimestamp = 'private-callback-timestamp-value';
    const logSalt = 'private-log-hash-salt';
    const turnstileClientToken = 'private-turnstile-client-value';
    const rawRequestBody = 'private-request-body';
    const rawObjectKey = `sessions/${rawLocatorSessionId}/input.json`;
    const rawAlternateObjectKey = 'private/artifacts/bundle.zip';
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const requestId = 'c56a4180-65aa-42ec-a945-5fd21dec0538';
    const finalizationId = 'c56a4180-65aa-42ec-a945-5fd21dec0539';
    const opaquePayload = JSON.stringify({ sessionId, token: 'private-serialized-token' });
    const rawS3ObjectUrl = [
      'https://private-bucket.',
      's3.ap-northeast-1.amazonaws.com/',
      `sessions/${rawLocatorSessionId}/input.json`,
    ].join('');
    const presigned = [
      'https://example.invalid/object?',
      'X-Amz-Algorithm=',
      'AWS4-HMAC-SHA256',
      '&X-Amz-Credential=',
      'synthetic',
      '&X-Amz-Signature=',
      'abcdef',
    ].join('');
    await withLogger({ level: 'info', format: 'json' }, async (logger) => {
      const { runWithLogContext } = await import('./requestLogContext');

      runWithLogContext({ requestId }, () => {
        logger.info('privacy payload', {
          vote: 'A',
          choice: 'B',
          rand: 'private-opening',
          token: 'opaque-token',
          capabilityToken: capability,
          callbackSignature: 'private-signature',
          clientSecret: 'private-secret',
          Authorization: `Bearer ${capability}`,
          cookieValue: 'private-cookie',
          sessionId,
          sessionIdentifier: rawSessionIdentifier,
          sourceIp: rawIp,
          'X-Real-IP': rawForwardedIp,
          remoteAddress: rawRemoteIp,
          LOG_IP_HASH_SALT: logSalt,
          turnstileToken: turnstileClientToken,
          'cf-turnstile-response': turnstileClientToken,
          'X-Finalization-Writer-Timestamp': callbackTimestamp,
          'X-Finalize-Timestamp': callbackTimestamp,
          timestampHeader: callbackTimestamp,
          rawBody: rawRequestBody,
          requestPayload: opaquePayload,
          s3BundleKey: rawObjectKey,
          reportKey: rawObjectKey,
          sourceKey: rawAlternateObjectKey,
          destinationKey: rawAlternateObjectKey,
          objectUrl: rawS3ObjectUrl,
          embeddedS3: 'failed for s3://private-bucket/sessions/raw-session/input.json',
          presigned,
          jwt,
          session_id_hash: 'sid_009d9486a2f2',
          source_ip_hash: 'ip_f24a371c2dd4',
          journal_hash: `0x${'a'.repeat(64)}`,
          bundle_key_prefix: 'key_53c8bca0f861',
          request_id: requestId,
          finalization_id: finalizationId,
          turnstile: { status: 'passed', error_code: 'none' },
          turnstile_status: 'passed',
          turnstile_error_code: 'none',
          body_size: 512,
          response_payload_present: true,
          input_votes: 12,
          votesCount: 12,
          tally: { A: 7, B: 5 },
        });
      });
    });

    const output = firstStringCall(logSpy);
    for (const forbidden of [
      'private-opening',
      'opaque-token',
      capability,
      'private-signature',
      'private-secret',
      'private-cookie',
      sessionId,
      rawLocatorSessionId,
      rawSessionIdentifier,
      rawIp,
      rawForwardedIp,
      rawRemoteIp,
      callbackTimestamp,
      logSalt,
      turnstileClientToken,
      rawRequestBody,
      rawObjectKey,
      rawAlternateObjectKey,
      opaquePayload,
      'private-serialized-token',
      rawS3ObjectUrl,
      'private-bucket',
      presigned,
      jwt,
    ]) {
      expect(output).not.toContain(forbidden);
    }
    expect(output).toContain('[REDACTED]');
    const parsed = parseJsonObject(output);
    expect(parsed['session_id_hash']).toBe('sid_009d9486a2f2');
    expect(parsed['source_ip_hash']).toBe('ip_f24a371c2dd4');
    expect(parsed['journal_hash']).toBe(`0x${'a'.repeat(64)}`);
    expect(parsed['bundle_key_prefix']).toBe('key_53c8bca0f861');
    expect(parsed['request_id']).toBe(requestId);
    expect(parsed['finalization_id']).toBe(finalizationId);
    expect(parsed['turnstile']).toEqual({ status: 'passed', error_code: 'none' });
    expect(parsed['turnstile_status']).toBe('passed');
    expect(parsed['turnstile_error_code']).toBe('none');
    expect(parsed['body_size']).toBe(512);
    expect(parsed['response_payload_present']).toBe(true);
    expect(parsed['input_votes']).toBe(12);
    expect(parsed['votesCount']).toBe(12);
    expect(parsed['tally']).toEqual({ A: 7, B: 5 });
  });

  it('scrubs raw session route values while retaining bounded structured error evidence', async () => {
    const rawSessionId = '550e8400-e29b-41d4-a716-446655440000';
    const rawRoute = `/api/sessions/${rawSessionId}/finalizations/current`;
    const artifactBase = `/api/sessions/${rawSessionId}/finalizations/finalization-safe/artifacts`;
    const bundleRoute = `${artifactBase}/bundle`;
    const reportRoute = `${artifactBase}/report`;

    await withLogger({ level: 'info', format: 'json' }, (logger) => {
      logger.error('structured failure', {
        http: { path: rawRoute },
        referer: `https://example.invalid/result?sessionId=${rawSessionId}`,
        diagnostic: `failed for sessionId=${rawSessionId}`,
        production_error: `Serialized session missing for ${rawSessionId}`,
        bundle_route: bundleRoute,
        report_route: reportRoute,
        error: {
          name: 'ArtifactReadError',
          message: `artifact read failed for ${rawRoute}`,
        },
      });
    });

    const output = firstStringCall(errorSpy);
    const parsed = parseJsonObject(output);
    const serializedError = getRecord(parsed['error']);
    expect(output).not.toContain(rawSessionId);
    expect(output).not.toContain(rawRoute);
    expect(output).not.toContain(bundleRoute);
    expect(output).not.toContain(reportRoute);
    expect(output).not.toContain('example.invalid');
    expect(serializedError?.['name']).toBe('ArtifactReadError');
    expect(serializedError?.['message']).toBe('[REDACTED]');
  });

  it('retains canonical route templates without allowing raw session paths through http.path', async () => {
    const template = '/api/sessions/:sessionId/finalizations/:finalizationId/artifacts/report';
    const rawPath =
      '/api/sessions/550e8400-e29b-41d4-a716-446655440000/finalizations/finalization-safe/artifacts/report';
    const mixedRawSessionPath =
      '/api/sessions/550e8400-e29b-41d4-a716-446655440000/finalizations/:finalizationId/artifacts/report';
    const mixedRawFinalizationPath = '/api/sessions/:sessionId/finalizations/finalization-safe/artifacts/report';
    const retiredRawArtifactPath = '/api/verification/bundles/raw-session/finalization-safe/report';

    await withLogger({ level: 'info', format: 'json' }, (logger) => {
      logger.info('template', {
        http: { path: template },
        raw_http: { path: rawPath },
        mixed_raw_session_http: { path: mixedRawSessionPath },
        mixed_raw_finalization_http: { path: mixedRawFinalizationPath },
        retired_raw_artifact_http: { path: retiredRawArtifactPath },
      });
    });

    const parsed = parseJsonObject(firstStringCall(logSpy));
    expect(getRecord(parsed['http'])?.['path']).toBe(template);
    expect(getRecord(parsed['raw_http'])?.['path']).toBe('[REDACTED]');
    expect(getRecord(parsed['mixed_raw_session_http'])?.['path']).toBe('[REDACTED]');
    expect(getRecord(parsed['mixed_raw_finalization_http'])?.['path']).toBe('[REDACTED]');
    expect(getRecord(parsed['retired_raw_artifact_http'])?.['path']).toBe('[REDACTED]');
    expect(firstStringCall(logSpy)).not.toContain('550e8400-e29b-41d4-a716-446655440000');
    expect(firstStringCall(logSpy)).not.toContain('finalization-safe');
    expect(firstStringCall(logSpy)).not.toContain('raw-session');
  });

  it('rejects spoofed hash and key-prefix fields unless their name and value use an approved shape', async () => {
    const rawSessionId = '550e8400-e29b-41d4-a716-446655440000';

    await withLogger({ level: 'info', format: 'json' }, (logger) => {
      logger.info('derived field validation', {
        session_id_hash: rawSessionId,
        bundle_key_prefix: 'private/artifacts/bundle.zip',
        secret_hash: 'plaintext-secret',
        authorization_hash: 'Basic private-credential',
        access_token_hash: 'opaque-token',
        expected_session_id_hash: 'sid_009d9486a2f2',
        path_hash: 'key_53c8bca0f861',
        journal_hash: `0x${'a'.repeat(64)}`,
        receiptHash: '0x12345678...',
      });
    });

    const parsed = parseJsonObject(firstStringCall(logSpy));
    for (const field of [
      'session_id_hash',
      'bundle_key_prefix',
      'secret_hash',
      'authorization_hash',
      'access_token_hash',
    ]) {
      expect(parsed[field]).toBe('[REDACTED]');
    }
    expect(parsed['expected_session_id_hash']).toBe('sid_009d9486a2f2');
    expect(parsed['path_hash']).toBe('key_53c8bca0f861');
    expect(parsed['journal_hash']).toBe(`0x${'a'.repeat(64)}`);
    expect(parsed['receiptHash']).toBe('0x12345678...');
  });

  it('uses one traversal budget across the complete record and all arguments', async () => {
    const wide = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field_${index}`, index]));
    const lateThrowingProxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('late argument must not be traversed');
        },
      },
    );

    await withLogger({ level: 'info', format: 'json' }, (logger) => {
      logger.info(
        'single budget',
        wide,
        ...Array.from({ length: 100 }, (_, index) => ({ [`arg_${index}`]: index })),
        lateThrowingProxy,
      );
    });

    const output = firstStringCall(logSpy);
    expect(output).not.toBe('{"level":"error","event":"log_sanitization_failed","message":"Log payload discarded"}');
    const parsed = parseJsonObject(output);
    expect(Object.keys(parsed).length).toBeLessThanOrEqual(70);
    expect(parsed).not.toHaveProperty('field_99');
    expect(parsed).not.toHaveProperty('arg_99');
    expect(output).not.toContain('late argument must not be traversed');
  });

  it('prioritizes a canonical event and Error over earlier arbitrary wide fields', async () => {
    const wide = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field_${index}`, index]));

    await withLogger({ level: 'info', format: 'json', includeStack: true }, (logger) => {
      logger.error('priority record', wide, { event: 'canonical_failure' }, new Error('bounded failure evidence'));
    });

    const parsed = parseJsonObject(firstStringCall(errorSpy));
    const serializedError = getRecord(parsed['error']);
    expect(parsed['event']).toBe('canonical_failure');
    expect(serializedError?.['message']).toBe('bounded failure evidence');
  });

  it('emits a fixed minimal record and discards the original payload when sanitization fails', async () => {
    const throwingProxy = new Proxy(
      { secret: 'must-not-survive' },
      {
        ownKeys: () => {
          throw new Error('proxy trap secret');
        },
      },
    );

    await withLogger({ level: 'info', format: 'json' }, (logger) => {
      expect(() => logger.info('original sensitive message', throwingProxy)).not.toThrow();
    });

    expect(firstStringCall(logSpy)).toBe(
      '{"level":"error","event":"log_sanitization_failed","message":"Log payload discarded"}',
    );
  });

  it('does not invoke throwing getters or toJSON methods', async () => {
    const value = {
      safe: 'visible',
      get dangerous(): string {
        throw new Error('getter secret');
      },
      toJSON(): never {
        throw new Error('toJSON secret');
      },
    };

    await withLogger({ level: 'info', format: 'json' }, (logger) => {
      expect(() => logger.info('accessor payload', value)).not.toThrow();
    });

    const output = firstStringCall(logSpy);
    expect(() => {
      JSON.parse(output);
    }).not.toThrow();
    expect(output).toContain('visible');
    expect(output).not.toContain('getter secret');
    expect(output).not.toContain('toJSON secret');
  });

  it('applies privacy scrubbing and bounds in text mode', async () => {
    const capability = `v1.${'a'.repeat(64)}.${'b'.repeat(64)}`;

    await withLogger({ level: 'info', format: 'text' }, (logger) => {
      expect(() =>
        logger.info('text payload', {
          capabilityToken: capability,
          location: 's3://private-bucket/sessions/raw-session/input.json',
          oversized: `${'x'.repeat(100_000)}END_OF_OVERSIZED_TEXT`,
          votesCount: 4,
        }),
      ).not.toThrow();
    });

    const output = logSpy.mock.calls.flat().map(String).join(' ');
    expect(output).not.toContain(capability);
    expect(output).not.toContain('private-bucket');
    expect(output).not.toContain('END_OF_OVERSIZED_TEXT');
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(output).toContain('votesCount');
  });

  it('does not activate request-context fields while text mode remains the default', async () => {
    await withLogger({ level: 'info', format: 'text' }, async (logger) => {
      const { runWithLogContext } = await import('./requestLogContext');

      runWithLogContext(
        {
          requestId: 'req-must-remain-dormant',
          http: { path: '/api/sessions/raw-session-id/finalizations/current' },
        },
        () => {
          logger.info('safe text message');
        },
      );
    });

    const output = firstStringCall(logSpy);
    expect(output).toContain('safe text message');
    expect(output).not.toContain('req-must-remain-dormant');
    expect(output).not.toContain('raw-session-id');
  });

  it('never throws when the console sink fails', async () => {
    logSpy.mockImplementation(() => {
      throw new Error('console unavailable');
    });

    await withLogger({ level: 'info', format: 'json' }, (logger) => {
      expect(() => logger.info('sink failure')).not.toThrow();
    });
  });
});

function firstStringCall(spy: { mock: { calls: unknown[][] } }): string {
  const value = spy.mock.calls[0]?.[0];
  return typeof value === 'string' ? value : '';
}

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
