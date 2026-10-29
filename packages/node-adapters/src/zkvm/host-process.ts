import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const HOST_EXECUTION_TIMEOUT_MS = 600_000;
const TERMINATION_GRACE_MS = 5_000;
const KILL_WAIT_MS = 1_000;
export const HOST_RESPONSE_TIMEOUT_MS = HOST_EXECUTION_TIMEOUT_MS + TERMINATION_GRACE_MS + KILL_WAIT_MS + 30_000;

type HostStage = 'starting' | 'proving' | 'output_decoded';
type HostOutcome =
  | 'success'
  | 'timeout'
  | 'spawn_error'
  | 'nonzero_exit'
  | 'signal'
  | 'interrupted'
  | 'cleanup_failure';

export interface HostProcessResult {
  readonly outcome: HostOutcome;
  readonly stage: HostStage;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly timeoutMs: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly errorCode: string | null;
  readonly stderrPresent: boolean;
  readonly cleanup: 'complete' | 'unconfirmed';
}

interface HostProcessOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly terminationGraceMs?: number;
  readonly killWaitMs?: number;
  readonly onStage?: (stage: HostStage) => void;
}

const activeHosts = new Set<() => Promise<HostProcessResult>>();
let shuttingDown = false;

/** Called once by the server's shutdown boundary, before it exits. */
export function shutdownHostProcesses(): Promise<readonly HostProcessResult[]> {
  shuttingDown = true;
  return Promise.all([...activeHosts].map((stop) => stop()));
}

export class HostProcessError extends Error {
  public readonly result: HostProcessResult;

  constructor(result: HostProcessResult) {
    super(result.outcome === 'timeout' ? 'zkVM execution timeout' : `zkVM host ${result.outcome}`);
    this.name = 'HostProcessError';
    this.result = result;
  }
}

/** Own one POSIX process group, drain private output, and retain only closed diagnostics. */
export function runHostProcess(
  executable: string,
  args: readonly string[],
  options: HostProcessOptions,
): Promise<HostProcessResult> {
  if (shuttingDown) throw new Error('Local zkVM supervisor is shutting down.');
  if (process.platform === 'win32') {
    throw new Error('Local zkVM execution requires POSIX process groups; use Linux, WSL, or macOS.');
  }
  const timeoutMs = options.timeoutMs ?? HOST_EXECUTION_TIMEOUT_MS;
  const terminationGraceMs = options.terminationGraceMs ?? TERMINATION_GRACE_MS;
  const killWaitMs = options.killWaitMs ?? KILL_WAIT_MS;
  for (const duration of [timeoutMs, terminationGraceMs, killWaitMs]) {
    if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 2_147_483_647) {
      throw new Error('Host process deadlines must be positive bounded integers.');
    }
  }
  const startedAt = new Date().toISOString();
  const started = performance.now();

  const completion: Promise<HostProcessResult> = new Promise((resolve) => {
    let stage: HostStage = 'starting';
    let outcome: HostOutcome | undefined;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let errorCode: string | null = null;
    let stderrPresent = false;
    let closed = false;
    let settled = false;
    let stopping = false;
    let pendingLine = '';
    let oversizedLine = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let finalWait: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const child = spawn(executable, [...args], {
      env: options.env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const deadline = setTimeout(() => {
      outcome = 'timeout';
      stop();
    }, timeoutMs);
    const stopForShutdown = (): Promise<HostProcessResult> => {
      outcome ??= 'interrupted';
      stop();
      return completion;
    };
    activeHosts.add(stopForShutdown);

    function groupExists(): boolean {
      if (child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
      }
    }

    function signalGroup(nextSignal: NodeJS.Signals): void {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, nextSignal);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
          outcome ??= 'cleanup_failure';
        }
      }
    }

    function finish(cleanup: HostProcessResult['cleanup']): void {
      if (settled) return;
      settled = true;
      activeHosts.delete(stopForShutdown);
      clearTimeout(deadline);
      clearTimeout(escalation);
      clearTimeout(finalWait);
      clearInterval(poll);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve({
        outcome: cleanup === 'unconfirmed' && outcome === 'success' ? 'cleanup_failure' : (outcome ?? 'spawn_error'),
        stage,
        startedAt,
        durationMs: Math.round(performance.now() - started),
        timeoutMs,
        exitCode,
        signal,
        errorCode,
        stderrPresent,
        cleanup,
      });
    }

    function checkStopped(): boolean {
      const stopped = closed && !groupExists();
      if (stopped) finish('complete');
      return stopped;
    }

    function stop(): void {
      if (stopping || settled) return;
      stopping = true;
      clearTimeout(deadline);
      signalGroup('SIGTERM');
      if (checkStopped()) return;
      poll = setInterval(checkStopped, 25);
      escalation = setTimeout(() => {
        signalGroup('SIGKILL');
        if (checkStopped()) return;
        finalWait = setTimeout(() => finish(closed && !groupExists() ? 'complete' : 'unconfirmed'), killWaitMs);
      }, terminationGraceMs);
    }

    function advanceProgress(line: string): void {
      const nextStage =
        line === 'Executing guest program and generating proof...'
          ? 'proving'
          : line === 'Output decoded successfully'
            ? 'output_decoded'
            : null;
      if (nextStage && (stage === 'starting' || (stage === 'proving' && nextStage === 'output_decoded'))) {
        stage = nextStage;
        options.onStage?.(stage);
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      // Arbitrary host output is private. Only two exact, bounded progress lines are admitted.
      for (const character of chunk.toString('utf8')) {
        if (character === '\n') {
          if (!oversizedLine) {
            advanceProgress(pendingLine);
          }
          pendingLine = '';
          oversizedLine = false;
        } else if (pendingLine.length < 128 && !oversizedLine) {
          pendingLine += character;
        } else {
          pendingLine = '';
          oversizedLine = true;
        }
      }
    });
    child.stderr.on('data', () => {
      stderrPresent = true;
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      outcome ??= 'spawn_error';
      errorCode = ['ENOENT', 'EACCES', 'EMFILE', 'ENFILE', 'ENOMEM', 'EINVAL'].includes(error.code ?? '')
        ? (error.code ?? null)
        : null;
      stop();
    });
    child.once('exit', (code, exitSignal) => {
      if (settled) return;
      exitCode = code;
      signal = exitSignal;
      outcome ??= exitSignal ? 'signal' : code === 0 ? 'success' : 'nonzero_exit';
      stop();
    });
    child.once('close', () => {
      closed = true;
      checkStopped();
    });
  });
  return completion;
}
