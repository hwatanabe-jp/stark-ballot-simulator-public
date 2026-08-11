import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStaticHonoServer, STATIC_API_ROUTE_MODE } from './static-hono-server';
import { logger } from '@stark-ballot/diagnostics/logger';
import { resolveRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

let server: Server | undefined;
let distDir: string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function closeServer(): Promise<void> {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  server = undefined;
}

async function createTestServer(): Promise<string> {
  distDir = await mkdtemp(join(tmpdir(), 'stark-ballot-static-hono-'));
  await writeFile(join(distDir, 'index.html'), '<!doctype html><main id="root">app shell</main>', 'utf-8');
  server = createStaticHonoServer(
    distDir,
    resolveRuntimeProfile({
      RUNTIME_PROFILE: 'static-mock-e2e',
    }),
  );
  return await new Promise<string>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected test server to listen on a TCP port.'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeServer();
  if (distDir) {
    await rm(distDir, { recursive: true, force: true });
    distDir = undefined;
  }
});

describe('static-hono-server', () => {
  it('activates bounded JSON logging with stacks for the local API runtime', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createTestServer();

    logger.error('Static server logger probe', { event: 'static_server_probe' }, new Error('synthetic failure'));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const output = String(errorSpy.mock.calls[0]?.[0]);
    const record: unknown = JSON.parse(output);
    expect(isRecord(record)).toBe(true);
    if (!isRecord(record)) {
      throw new Error('Expected a structured logger record');
    }
    expect(record['level']).toBe('error');
    expect(record['service']).toBe('local-static-api');
    expect(record['event']).toBe('static_server_probe');
    const error = record['error'];
    expect(isRecord(error)).toBe(true);
    if (!isRecord(error)) {
      throw new Error('Expected a structured logger error');
    }
    expect(error['message']).toBe('synthetic failure');
    expect(typeof error['stack']).toBe('string');
  });

  it('uses the target lambda route set and does not expose retired debug enable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(STATIC_API_ROUTE_MODE).toBe('lambda');
    const baseUrl = await createTestServer();

    const response = await fetch(`${baseUrl}/api/debug/enable?token=debug-token`, { redirect: 'manual' });

    expect(response.status).toBe(404);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const output = String(warnSpy.mock.calls[0]?.[0]);
    const record: unknown = JSON.parse(output);
    expect(isRecord(record)).toBe(true);
    if (!isRecord(record)) {
      throw new Error('Expected a structured request log record');
    }
    expect(record['level']).toBe('warn');
    expect(record['service']).toBe('local-static-api');
    expect(record['event']).toBe('http_request');
    const http = record['http'];
    expect(isRecord(http)).toBe(true);
    if (!isRecord(http)) {
      throw new Error('Expected structured request HTTP fields');
    }
    expect(http['method']).toBe('GET');
    expect(http['path']).toBe('/api/*');
    expect(http['status']).toBe(404);
  });

  it.each(['debug', 'stark_ballot_debug'])('serves debug query %s as static app shell only', async (param) => {
    const baseUrl = await createTestServer();

    const response = await fetch(`${baseUrl}/?${param}=debug-token`, { redirect: 'manual' });

    expect(response.status).toBe(200);
    expect(response.redirected).toBe(false);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    await expect(response.text()).resolves.toContain('app shell');
  });
});
