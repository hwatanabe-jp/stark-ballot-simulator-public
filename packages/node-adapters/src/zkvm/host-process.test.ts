import { afterEach, describe, expect, it, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runHostProcess } from './host-process';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const options = { env: process.env, timeoutMs: 10_000, terminationGraceMs: 100, killWaitMs: 1_000 };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.skipIf(process.platform === 'win32')('owned host process lifecycle', { timeout: 15_000 }, () => {
  it('drains private output and admits only exact progress lines', async () => {
    const stages: string[] = [];
    const result = await runHostProcess(
      process.execPath,
      [
        '-e',
        `
      process.stdout.write('PRIVATE_INPUT_' + 'x'.repeat(2_000_000) + '\\n');
      process.stderr.write('PRIVATE_STDERR_' + 'x'.repeat(2_000_000));
      process.stdout.write('Executing guest program ');
      setTimeout(() => process.stdout.write('and generating proof...\\nOutput decoded successfully\\n'), 10);
    `,
      ],
      { ...options, onStage: (stage) => stages.push(stage) },
    );
    expect(result).toMatchObject({ outcome: 'success', exitCode: 0, stderrPresent: true, cleanup: 'complete' });
    expect(stages).toEqual(['proving', 'output_decoded']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('reports a spawn failure without disclosing the executable path', async () => {
    const result = await runHostProcess('/nonexistent/PRIVATE_EXECUTABLE', [], options);
    expect(result).toMatchObject({ outcome: 'spawn_error', errorCode: 'ENOENT', cleanup: 'complete' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('does not classify an external signal as a timeout', async () => {
    const result = await runHostProcess(process.execPath, ['-e', `process.kill(process.pid, 'SIGTERM')`], options);
    expect(result).toMatchObject({ outcome: 'signal', signal: 'SIGTERM', exitCode: null });
  });

  it('keeps nonzero exit status distinct from a deadline', async () => {
    const result = await runHostProcess(process.execPath, ['-e', 'process.exit(7)'], options);
    expect(result).toMatchObject({ outcome: 'nonzero_exit', exitCode: 7, signal: null });
  });

  it('escalates an ignored deadline signal after the configured grace period', async () => {
    // Test deadline policy without assuming an OS process can start within 500ms.
    // The descendant integration below still verifies actual process-group killing.
    vi.useFakeTimers();
    const child = new childProcess.ChildProcess();
    const stdout = new PassThrough();
    Object.defineProperties(child, {
      pid: { value: 4242 },
      stdout: { value: stdout },
      stderr: { value: new PassThrough() },
    });
    vi.mocked(childProcess.spawn).mockReturnValueOnce(child);
    let alive = true;
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(pid).toBe(-4242);
      if (!alive) throw Object.assign(new Error('No process group'), { code: 'ESRCH' });
      if (signal === 'SIGKILL') {
        alive = false;
        child.emit('exit', null, 'SIGKILL');
        child.emit('close', null, 'SIGKILL');
      }
      return true;
    });
    const execution = runHostProcess(process.execPath, [], { ...options, timeoutMs: 500 });
    stdout.write('Executing guest program and generating proof...\n');
    await vi.advanceTimersByTimeAsync(499);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(options.terminationGraceMs - 1);
    expect(kill).not.toHaveBeenCalledWith(-4242, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(1);
    const result = await execution;
    expect(result).toMatchObject({ outcome: 'timeout', stage: 'proving', signal: 'SIGKILL' });
    expect(result.cleanup).toBe('complete');
  });

  it('stops descendants holding stdio open after the host exits', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'host-process-test-'));
    const pidFile = path.join(directory, 'child.pid');
    try {
      const result = await runHostProcess(
        process.execPath,
        [
          '-e',
          `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e',
        "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"
      ], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      require('node:fs').writeFileSync(process.argv[1], String(child.pid));
      child.once('message', () => process.exit(9));
    `,
          pidFile,
        ],
        options,
      );
      expect(result.outcome).toBe('nonzero_exit');
      expect(result.exitCode).toBe(9);
      const pid = Number(await readFile(pidFile, 'utf8'));
      let running = false;
      try {
        process.kill(pid, 0);
        running = process.platform !== 'linux' || !/\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8'));
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && (error.code === 'ESRCH' || error.code === 'ENOENT')))
          throw error;
      }
      expect(running).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
