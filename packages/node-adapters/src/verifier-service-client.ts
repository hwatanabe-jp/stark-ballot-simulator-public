import { spawn, type StdioOptions } from 'node:child_process';
import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import {
  parseVerifierServiceExitCode,
  parseVerifierServiceProtocol,
  type VerifierServiceDevModeReport,
  type VerifierServiceFailedReport,
  type VerifierServiceSuccessReport,
} from '@stark-ballot/verification/verifier-service-report';

export type VerifierStderrCategory = 'none' | 'present' | 'truncated';
export const VERIFIER_STDERR_CAPTURE_LIMIT_BYTES = 4 * 1024;
const VERIFIER_REPORT_MAX_BYTES = 1024 * 1024;

export interface VerifierInvocationDiagnostics {
  stderrCategory: VerifierStderrCategory;
  stderrBytes: number;
  stderrTruncated: boolean;
}

export class VerifierServiceExecutionError extends Error {
  readonly diagnostics: VerifierInvocationDiagnostics;

  constructor(message: string, diagnostics: VerifierInvocationDiagnostics) {
    super(message);
    this.name = 'VerifierServiceExecutionError';
    this.diagnostics = diagnostics;
  }
}

export interface VerifierInvocationOptions {
  bundlePath: string;
  expectedImageId: string;
  reportPath: string;
  binaryPath?: string;
  /**
   * Optional spawn implementation (primarily for tests).
   */
  spawnImpl?: SpawnImpl;
}

interface VerifierInvocationResultBase {
  reportPath: string;
  bundlePath: string;
  diagnostics?: VerifierInvocationDiagnostics;
}

export type VerifierInvocationResult =
  | (VerifierInvocationResultBase & {
      status: 'success';
      report: VerifierServiceSuccessReport;
    })
  | (VerifierInvocationResultBase & {
      status: 'dev_mode';
      report: VerifierServiceDevModeReport;
    })
  | (VerifierInvocationResultBase & {
      status: 'failed';
      report: VerifierServiceFailedReport;
    });

export interface SpawnOptions {
  stdio: StdioOptions;
  env?: NodeJS.ProcessEnv;
}

export interface SpawnedProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: (code: number | null) => void): void;
}

export type SpawnImpl = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess;

interface BoundedStreamCapture {
  append(chunk: unknown): void;
  diagnostics(): VerifierInvocationDiagnostics;
}

function createBoundedStreamCapture(limitBytes: number): BoundedStreamCapture {
  const storage = Buffer.alloc(limitBytes);
  let capturedBytes = 0;
  let truncated = false;

  return {
    append(chunk: unknown): void {
      try {
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(typeof chunk === 'string' ? chunk : String(chunk), 'utf8');
        const remaining = limitBytes - capturedBytes;
        if (remaining <= 0) {
          truncated = true;
          return;
        }
        const bytesToCapture = Math.min(buffer.byteLength, remaining);
        if (bytesToCapture > 0) {
          buffer.copy(storage, capturedBytes, 0, bytesToCapture);
          capturedBytes += bytesToCapture;
        }
        if (bytesToCapture < buffer.byteLength) {
          truncated = true;
        }
      } catch {
        truncated = true;
      }
    },
    diagnostics(): VerifierInvocationDiagnostics {
      return {
        stderrCategory: truncated ? 'truncated' : capturedBytes > 0 ? 'present' : 'none',
        stderrBytes: capturedBytes,
        stderrTruncated: truncated,
      };
    },
  };
}

export async function invokeVerifierService(options: VerifierInvocationOptions): Promise<VerifierInvocationResult> {
  const binaryPath = await resolveBinaryPath(options.binaryPath);

  await fs.mkdir(path.dirname(options.reportPath), { recursive: true });

  const args = [
    'verify',
    '--bundle',
    options.bundlePath,
    '--image-id',
    options.expectedImageId,
    '--output',
    options.reportPath,
    '--quiet',
  ];

  const spawnFn: SpawnImpl =
    options.spawnImpl ??
    ((command, args, spawnOptions) => {
      return spawn(command, args, spawnOptions);
    });
  const child = spawnFn(binaryPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
    },
  });

  const stderrCapture = createBoundedStreamCapture(VERIFIER_STDERR_CAPTURE_LIMIT_BYTES);

  if (!child.stdout || !child.stderr) {
    throw new Error('verifier-service did not provide stdout/stderr streams');
  }

  child.stdout.on('data', () => undefined);

  child.stderr.on('data', (data: unknown) => {
    stderrCapture.append(data);
  });

  const exitCode: number | null = await new Promise((resolve, reject) => {
    child.on('error', () =>
      reject(new VerifierServiceExecutionError('verifier-service process failed', stderrCapture.diagnostics())),
    );
    child.on('close', (code) => resolve(code));
  });

  if (exitCode === null) {
    throw new VerifierServiceExecutionError('verifier-service did not exit cleanly', stderrCapture.diagnostics());
  }

  if (exitCode === 1) {
    throw new VerifierServiceExecutionError('verifier-service exited with status 1', stderrCapture.diagnostics());
  }

  let admittedExitCode: ReturnType<typeof parseVerifierServiceExitCode>;
  try {
    admittedExitCode = parseVerifierServiceExitCode(exitCode);
  } catch {
    throw new VerifierServiceExecutionError(
      'verifier-service exited with an unsupported status',
      stderrCapture.diagnostics(),
    );
  }

  let reportInput: unknown;
  try {
    reportInput = await readVerificationReport(options.reportPath);
  } catch {
    throw new VerifierServiceExecutionError(
      'verifier-service report unavailable or invalid',
      stderrCapture.diagnostics(),
    );
  }

  let protocol: ReturnType<typeof parseVerifierServiceProtocol>;
  try {
    protocol = parseVerifierServiceProtocol(admittedExitCode, reportInput);
  } catch {
    throw new VerifierServiceExecutionError(
      'verifier-service report unavailable or invalid',
      stderrCapture.diagnostics(),
    );
  }

  if (
    protocol.wireReport.expected_image_id !== options.expectedImageId ||
    protocol.wireReport.bundle_path !== path.basename(options.bundlePath)
  ) {
    throw new VerifierServiceExecutionError(
      'verifier-service report does not match invocation',
      stderrCapture.diagnostics(),
    );
  }

  const commonResult = {
    reportPath: options.reportPath,
    bundlePath: options.bundlePath,
    diagnostics: stderrCapture.diagnostics(),
  };
  switch (protocol.status) {
    case 'success':
      return { ...commonResult, status: 'success', report: protocol.report };
    case 'dev_mode':
      return { ...commonResult, status: 'dev_mode', report: protocol.report };
    case 'failed':
      return { ...commonResult, status: 'failed', report: protocol.report };
  }
}

async function resolveBinaryPath(explicitPath?: string): Promise<string> {
  const candidates = [
    explicitPath,
    process.env['VERIFIER_SERVICE_BIN'],
    path.join(process.cwd(), 'verifier-service', 'target', 'release', 'verifier-service'),
    path.join(process.cwd(), 'verifier-service', 'target', 'debug', 'verifier-service'),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // continue searching
    }
  }

  throw new Error('verifier-service binary not found. Set VERIFIER_SERVICE_BIN or build the project.');
}

async function readVerificationReport(reportPath: string): Promise<unknown> {
  const handle = await fs.open(reportPath, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > VERIFIER_REPORT_MAX_BYTES) {
      throw new Error('verifier-service report exceeds the admitted file bounds');
    }

    const content = Buffer.alloc(VERIFIER_REPORT_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < content.byteLength) {
      const result = await handle.read(content, bytesRead, content.byteLength - bytesRead, null);
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }

    if (bytesRead > VERIFIER_REPORT_MAX_BYTES) {
      throw new Error('verifier-service report exceeds the admitted file bounds');
    }

    const parsed: unknown = JSON.parse(content.toString('utf8', 0, bytesRead));
    return parsed;
  } finally {
    await handle.close();
  }
}
