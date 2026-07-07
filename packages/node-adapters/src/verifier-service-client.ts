import { spawn, type StdioOptions } from 'node:child_process';
import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

export type VerifierStatus = 'success' | 'failed' | 'dev_mode';

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

interface VerifierServiceWireReport {
  status: VerifierStatus;
  verifier_version: string;
  verified_at: string;
  duration_ms: number;
  expected_image_id: string;
  receipt_image_id: string | null;
  bundle_path: string;
  receipt_path: string;
  dev_mode_receipt: boolean;
  errors?: string[];
}

type VerifierServiceReport = VerificationReport & {
  status: VerifierStatus;
};

export interface VerificationReport {
  status: VerifierStatus;
  verifier_version: string;
  verified_at: string;
  duration_ms: number;
  expected_image_id: string;
  receipt_image_id: string | null;
  dev_mode_receipt: boolean;
  errors?: string[];
}

export interface VerifierInvocationResult {
  status: VerifierStatus;
  reportPath: string;
  bundlePath: string;
  report: VerifierServiceReport;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseVerifierStatus(value: unknown): VerifierStatus {
  if (value === 'success' || value === 'failed' || value === 'dev_mode') {
    return value;
  }
  throw new Error('verifier-service report status is invalid');
}

function parseRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`verifier-service report ${key} is required`);
  }
  return value;
}

function parseDurationMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('verifier-service report duration_ms is invalid');
  }
  return value;
}

function parseReceiptImageId(value: unknown): string | null {
  if (value === null || typeof value === 'string') {
    return value;
  }
  throw new Error('verifier-service report receipt_image_id is invalid');
}

function parseDevModeReceipt(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  throw new Error('verifier-service report dev_mode_receipt is required');
}

function parseErrors(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('verifier-service report errors must be strings');
  }
  return value.map((entry) => String(entry));
}

export function parseVerifierServiceReport(input: unknown): VerifierServiceReport {
  if (!isRecord(input)) {
    throw new Error('verifier-service report must be an object');
  }

  const wireReport: VerifierServiceWireReport = {
    status: parseVerifierStatus(input['status']),
    verifier_version: parseRequiredString(input, 'verifier_version'),
    verified_at: parseRequiredString(input, 'verified_at'),
    duration_ms: parseDurationMs(input['duration_ms']),
    expected_image_id: parseRequiredString(input, 'expected_image_id'),
    receipt_image_id: parseReceiptImageId(input['receipt_image_id']),
    bundle_path: parseRequiredString(input, 'bundle_path'),
    receipt_path: parseRequiredString(input, 'receipt_path'),
    dev_mode_receipt: parseDevModeReceipt(input['dev_mode_receipt']),
    ...omitUndefinedProperties({ errors: parseErrors(input['errors']) }),
  };

  return {
    status: wireReport.status,
    verifier_version: wireReport.verifier_version,
    verified_at: wireReport.verified_at,
    duration_ms: wireReport.duration_ms,
    expected_image_id: wireReport.expected_image_id,
    receipt_image_id: wireReport.receipt_image_id,
    dev_mode_receipt: wireReport.dev_mode_receipt,
    ...(wireReport.errors ? { errors: wireReport.errors } : {}),
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

  let stdout = '';
  let stderr = '';

  const appendChunk = (chunk: unknown): string => {
    if (typeof chunk === 'string') {
      return chunk;
    }
    if (Buffer.isBuffer(chunk)) {
      return chunk.toString('utf-8');
    }
    return String(chunk);
  };

  if (!child.stdout || !child.stderr) {
    throw new Error('verifier-service did not provide stdout/stderr streams');
  }

  child.stdout.on('data', (data: unknown) => {
    stdout += appendChunk(data);
  });

  child.stderr.on('data', (data: unknown) => {
    stderr += appendChunk(data);
  });

  const exitCode: number | null = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });

  if (exitCode === null) {
    throw new Error('verifier-service did not exit cleanly');
  }

  if (exitCode === 1) {
    throw new Error(stderr.trim() || 'verifier-service exited with status 1 (general error)');
  }

  const report = await readVerificationReport(options.reportPath, stdout);

  return {
    status: report.status,
    reportPath: options.reportPath,
    bundlePath: options.bundlePath,
    report,
  };
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

async function readVerificationReport(reportPath: string, fallbackStdout: string): Promise<VerifierServiceReport> {
  try {
    const content = await fs.readFile(reportPath, 'utf-8');
    return parseVerifierServiceReport(JSON.parse(content));
  } catch {
    if (fallbackStdout.trim().length > 0) {
      return parseVerifierServiceReport(JSON.parse(fallbackStdout));
    }
    throw new Error('verification report not generated by verifier-service');
  }
}
