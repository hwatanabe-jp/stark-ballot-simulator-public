import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStaticHonoServer, STATIC_API_ROUTE_MODE } from './static-hono-server';

let server: Server | undefined;
let distDir: string | undefined;

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
  server = createStaticHonoServer(distDir);
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
  await closeServer();
  if (distDir) {
    await rm(distDir, { recursive: true, force: true });
    distDir = undefined;
  }
});

describe('static-hono-server', () => {
  it('uses the target lambda route set and does not expose retired debug enable', async () => {
    expect(STATIC_API_ROUTE_MODE).toBe('lambda');
    const baseUrl = await createTestServer();

    const response = await fetch(`${baseUrl}/api/debug/enable?token=debug-token`, { redirect: 'manual' });

    expect(response.status).toBe(404);
    expect(response.headers.get('set-cookie')).toBeNull();
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
