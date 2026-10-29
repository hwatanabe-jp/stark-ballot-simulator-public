import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { get, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStaticHonoServer, STATIC_API_ROUTE_MODE } from './static-hono-server';
import { logger } from '@stark-ballot/diagnostics/logger';
import { resolveRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

let server: Server | undefined;
let distDir: string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function stopFixtureHost(pidFile: string): Promise<void> {
  try {
    const hostPid = Number(await readFile(pidFile, 'utf8'));
    process.kill(-hostPid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH'))) {
      throw error;
    }
  }
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

describe.skipIf(process.platform === 'win32')('static server shutdown', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)(
    'stops an active host before exiting on repeated %s',
    async (signal) => {
      const directory = await mkdtemp(join(tmpdir(), 'stark-ballot-server-shutdown-'));
      const pidFile = join(directory, 'host.pid');
      const resultFile = join(directory, 'result.json');
      const hostCode = `
      process.on('SIGTERM', () => {});
      process.on('SIGINT', () => {});
      require('node:fs').writeFileSync(process.argv[1], String(process.pid));
      process.stdout.write('Executing guest program and generating proof...\\n');
      setInterval(() => {}, 1000);
    `;
      const supervisorCode = `
      import { createServer } from 'node:http';
      import { writeFile } from 'node:fs/promises';
      import { installStaticServerShutdown } from ${JSON.stringify(new URL('./static-server-shutdown.ts', import.meta.url).href)};
      import { runHostProcess, shutdownHostProcesses } from ${JSON.stringify(new URL('../../packages/node-adapters/src/zkvm/host-process.ts', import.meta.url).href)};
      const server = createServer((request, response) => response.write('in progress'));
      installStaticServerShutdown(server);
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const result = await runHostProcess(process.execPath, ['-e', ${JSON.stringify(hostCode)}, ${JSON.stringify(pidFile)}], {
        env: process.env, timeoutMs: 30000, terminationGraceMs: 200, killWaitMs: 1000,
        onStage: () => process.send({ port: server.address().port }),
      });
      const remainingHosts = (await shutdownHostProcesses()).length;
      let newWorkRejected = false;
      try {
        await runHostProcess(process.execPath, ['-e', 'process.exit(0)'], { env: process.env });
      } catch (error) {
        newWorkRejected = error instanceof Error && error.message === 'Local zkVM supervisor is shutting down.';
      }
      await writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ ...result, remainingHosts, newWorkRejected }));
    `;
      const supervisor = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', supervisorCode], {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let stderr = '';
      supervisor.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4_096);
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
        supervisor.once('exit', (code, exitSignal) => resolveExit({ code, signal: exitSignal }));
      });
      // Startup/import work and shutdown each have their own bounded budget.
      let watchdogExpired = false;
      let forceKill: ReturnType<typeof setTimeout> | undefined;
      const expireWatchdog = () => {
        watchdogExpired = true;
        // Let the supervisor clean up a host that has not yet written its PID file.
        supervisor.kill('SIGTERM');
        forceKill = setTimeout(() => supervisor.kill('SIGKILL'), 2_000);
      };
      let watchdog = setTimeout(expireWatchdog, 10_000);
      try {
        const port = await new Promise<number>((resolvePort, reject) => {
          supervisor.once('error', reject);
          supervisor.once('exit', () => reject(new Error(`Supervisor exited before starting the host: ${stderr}`)));
          supervisor.once('message', (message: unknown) => {
            if (!isRecord(message) || typeof message['port'] !== 'number') {
              reject(new Error('Invalid fixture readiness message'));
              return;
            }
            resolvePort(message['port']);
          });
        });
        const response = await new Promise<import('node:http').IncomingMessage>((resolveResponse, reject) => {
          get(`http://127.0.0.1:${port}`, resolveResponse).once('error', reject);
        });
        response.resume();
        response.on('error', () => undefined); // An interrupted response is expected during shutdown.
        const connectionClosed = new Promise<void>((resolveClosed) => response.once('close', resolveClosed));
        clearTimeout(watchdog);
        watchdog = setTimeout(expireWatchdog, 5_000);
        supervisor.kill(signal);
        await wait(25);
        supervisor.kill(signal);
        expect(await exited).toEqual({ code: signal === 'SIGINT' ? 130 : 143, signal: null });
        expect(watchdogExpired, 'Fixture exceeded its startup or shutdown budget').toBe(false);
        await connectionClosed;
        expect(JSON.parse(await readFile(resultFile, 'utf8'))).toMatchObject({
          outcome: 'interrupted',
          signal: 'SIGKILL',
          cleanup: 'complete',
          remainingHosts: 0,
          newWorkRejected: true,
        });
        const hostPid = Number(await readFile(pidFile, 'utf8'));
        expect(() => process.kill(hostPid, 0)).toThrow();
      } finally {
        clearTimeout(watchdog);
        clearTimeout(forceKill);
        supervisor.kill('SIGKILL');
        await exited;
        await stopFixtureHost(pidFile);
        await rm(directory, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
