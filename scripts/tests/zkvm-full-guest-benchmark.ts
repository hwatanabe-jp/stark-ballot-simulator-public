#!/usr/bin/env tsx

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { RFC6962MerkleTree } from '@stark-ballot/merkle/rfc6962-merkle-tree';
import { addHexPrefix } from '@stark-ballot/crypto-primitives';
import { serializeZkvmAggregatorInput } from '@stark-ballot/zkvm-contract/zkvm/host-io';
import { computeCommitment, type ZkVMInput, type VoteWithProof } from '@stark-ballot/zkvm-contract/zkvm/types';

type HexString = `0x${string}`;

type Metric<T> =
  | {
      status: 'measured';
      value: T;
      unit: string;
      method: string;
    }
  | {
      status: 'unavailable';
      reason: string;
    };

type BenchmarkOptions = {
  hostBin: string;
  iterations: number;
  slots: number;
  outputPath?: string;
  keepArtifacts: boolean;
  showHelp: boolean;
};

type ChildRunResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  wallTimeMs: number;
};

type ImageIdPayload = {
  imageId: string;
  methodVersion: number;
};

type RunMeasurement = {
  iteration: number;
  inputPath: string;
  outputPath: string;
  receiptPath: string;
  wallTimeMs: number;
  receiptSizeBytes: number;
  outputSizeBytes: number;
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
};

type MeasurementSummary = {
  iterations: number;
  median: number;
  p95: number;
  max: number;
};

type BenchmarkReport = {
  schema: 'stark-ballot.zkvm-full-guest-benchmark.v1';
  generatedAt: string;
  fixture: {
    slots: number;
    treeSize: number;
    totalExpected: number;
    inputBytes: number;
  };
  command: {
    hostBin: string;
    productionMode: true;
    risc0DevMode: 'unset';
  };
  imageId: ImageIdPayload;
  artifactsRetained: boolean;
  metrics: {
    guestCycles: Metric<never>;
    executionTimeMs: Metric<never>;
    proofTimeMs: Metric<never>;
    combinedHostWallTimeMs: Metric<MeasurementSummary>;
    shaPrecompileActivity: Metric<never>;
    receiptSizeBytes: Metric<MeasurementSummary>;
    hostJsonParseTimeMs: Metric<never>;
    hostSerializationTimeMs: Metric<never>;
    processStartupOverheadMs: Metric<number>;
  };
  runs: RunMeasurement[];
};

const DEFAULT_SLOTS = 64;
const DEFAULT_ITERATIONS = 1;
const ELECTION_ID = '550e8400-e29b-41d4-a716-446655440000';
const MAX_CAPTURED_OUTPUT_CHARS = 4_000;

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

function parsePositiveInteger(raw: string, label: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be a safe integer: ${raw}`);
  }
  return parsed;
}

function readOptionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseBenchmarkArgs(argv: string[], cwd = process.cwd()): BenchmarkOptions {
  const normalized = argv.filter((value) => value !== '--');
  const options: BenchmarkOptions = {
    hostBin: path.resolve(cwd, 'zkvm/target/release/host'),
    iterations: DEFAULT_ITERATIONS,
    slots: DEFAULT_SLOTS,
    keepArtifacts: false,
    showHelp: false,
  };

  for (let index = 0; index < normalized.length; index += 1) {
    const value = strictDefined(normalized[index], 'argument');
    if (value === '--help' || value === '-h') {
      options.showHelp = true;
      continue;
    }
    if (value === '--keep-artifacts') {
      options.keepArtifacts = true;
      continue;
    }
    if (value === '--host-bin') {
      options.hostBin = path.resolve(cwd, readOptionValue(normalized, index, value));
      index += 1;
      continue;
    }
    if (value.startsWith('--host-bin=')) {
      options.hostBin = path.resolve(cwd, value.slice('--host-bin='.length));
      continue;
    }
    if (value === '--iterations' || value === '-n') {
      options.iterations = parsePositiveInteger(readOptionValue(normalized, index, value), 'iterations');
      index += 1;
      continue;
    }
    if (value.startsWith('--iterations=')) {
      options.iterations = parsePositiveInteger(value.slice('--iterations='.length), 'iterations');
      continue;
    }
    if (value === '--slots') {
      options.slots = parsePositiveInteger(readOptionValue(normalized, index, value), 'slots');
      index += 1;
      continue;
    }
    if (value.startsWith('--slots=')) {
      options.slots = parsePositiveInteger(value.slice('--slots='.length), 'slots');
      continue;
    }
    if (value === '--output') {
      options.outputPath = path.resolve(cwd, readOptionValue(normalized, index, value));
      index += 1;
      continue;
    }
    if (value.startsWith('--output=')) {
      options.outputPath = path.resolve(cwd, value.slice('--output='.length));
      continue;
    }
    throw new Error(`Unknown option: ${value}`);
  }

  return options;
}

function helpText(): string {
  return [
    'Usage: pnpm tsx scripts/tests/zkvm-full-guest-benchmark.ts [options]',
    '',
    'Options:',
    '  --host-bin <path>       Built zkVM host binary. Default: zkvm/target/release/host',
    '  --iterations, -n <n>    Production proof runs. Default: 1',
    '  --slots <n>             Full-guest fixture slots. Default: 64',
    '  --output <path>         Write the structured JSON report to a file',
    '  --keep-artifacts        Keep temporary input, output, receipt, and bitmap artifacts',
  ].join('\n');
}

function toHex(buffer: Buffer): HexString {
  return `0x${buffer.toString('hex')}`;
}

function repeatByteHex(value: number): HexString {
  return `0x${value.toString(16).padStart(2, '0').repeat(32)}`;
}

function computeLogId(slots: number): HexString {
  return toHex(createHash('sha256').update(`stark-ballot:zkvm-full-guest-benchmark:${slots}`).digest());
}

function computeElectionConfigHash(slots: number): HexString {
  return toHex(createHash('sha256').update(`stark-ballot:election-config:benchmark:${slots}`).digest());
}

export function buildFullGuestBenchmarkInput(slots: number): ZkVMInput {
  if (!Number.isSafeInteger(slots) || slots <= 0) {
    throw new Error(`slots must be a positive safe integer: ${slots}`);
  }

  const commitments: HexString[] = Array.from(
    { length: slots },
    (_, index) => computeCommitment(ELECTION_ID, index % 5, repeatByteHex((index % 255) + 1)) as HexString,
  );
  const tree = new RFC6962MerkleTree();
  for (const commitment of commitments) {
    tree.append(commitment);
  }

  const votes: VoteWithProof[] = commitments.map((commitment, index) => ({
    commitment,
    choice: index % 5,
    random: repeatByteHex((index % 255) + 1),
    index,
    merklePath: tree.getInclusionProof(index, commitments.length).proofNodes.map((node) => addHexPrefix(node)),
  }));

  return {
    electionId: ELECTION_ID,
    bulletinRoot: addHexPrefix(tree.getRoot()),
    treeSize: slots,
    logId: computeLogId(slots),
    timestamp: 1_725_000_000_000,
    totalExpected: slots,
    electionConfigHash: computeElectionConfigHash(slots),
    votes,
  };
}

function assertByteArray(value: unknown, length: number, label: string): asserts value is number[] {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    !value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
  ) {
    throw new Error(`${label} must be an array of ${length} bytes`);
  }
}

function assertSerializedHostInput(value: unknown, slots: number): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Serialized host input must be an object');
  }
  const record = value as Record<string, unknown>;
  assertByteArray(record['election_id'], 16, 'election_id');
  assertByteArray(record['bulletin_root'], 32, 'bulletin_root');
  assertByteArray(record['log_id'], 32, 'log_id');
  assertByteArray(record['election_config_hash'], 32, 'election_config_hash');
  if (record['tree_size'] !== slots || record['total_expected'] !== slots) {
    throw new Error(`Serialized host input must have tree_size and total_expected ${slots}`);
  }
  if (!Array.isArray(record['votes']) || record['votes'].length !== slots) {
    throw new Error(`Serialized host input must contain ${slots} votes`);
  }
}

export function buildSerializedBenchmarkInput(slots: number): Record<string, unknown> {
  const serialized = serializeZkvmAggregatorInput(buildFullGuestBenchmarkInput(slots));
  assertSerializedHostInput(serialized, slots);
  return serialized;
}

function productionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['RISC0_DEV_MODE'];
  return env;
}

function tailOutput(value: string): string {
  return value.length <= MAX_CAPTURED_OUTPUT_CHARS ? value : value.slice(value.length - MAX_CAPTURED_OUTPUT_CHARS);
}

async function runChild(command: string, args: string[], cwd: string): Promise<ChildRunResult> {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: productionEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        wallTimeMs: performance.now() - start,
      });
    });
  });
}

function parseImageIdPayload(stdout: string): ImageIdPayload {
  const trimmed = stdout.trim();
  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ImageID output must be an object');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record['imageId'] !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(record['imageId'])) {
    throw new Error('ImageID output is missing a 32-byte imageId');
  }
  if (!Number.isInteger(record['methodVersion']) || Number(record['methodVersion']) <= 0) {
    throw new Error('ImageID output is missing a positive methodVersion');
  }
  return {
    imageId: record['imageId'],
    methodVersion: Number(record['methodVersion']),
  };
}

function parseOutputArtifact(raw: string, slots: number): void {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Host output artifact must be an object');
  }
  const record = parsed as Record<string, unknown>;
  if (record['treeSize'] !== slots || record['totalExpected'] !== slots) {
    throw new Error(`Host output artifact must have treeSize and totalExpected ${slots}`);
  }
  if (!Number.isInteger(record['methodVersion']) || Number(record['methodVersion']) <= 0) {
    throw new Error('Host output artifact is missing methodVersion');
  }
  if (typeof record['imageId'] !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(record['imageId'])) {
    throw new Error('Host output artifact is missing imageId');
  }
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) {
    throw new Error('Cannot summarize an empty measurement set');
  }
  const index = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
  return strictDefined(sortedValues[Math.min(Math.max(index, 0), sortedValues.length - 1)], 'percentile value');
}

export function summarizeMeasurements(values: number[]): MeasurementSummary {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) {
    throw new Error('Cannot summarize an empty measurement set');
  }
  const middleIndex = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (strictDefined(sorted[middleIndex - 1], 'lower median') + strictDefined(sorted[middleIndex], 'upper median')) /
        2
      : strictDefined(sorted[middleIndex], 'median');

  return {
    iterations: values.length,
    median,
    p95: percentile(sorted, 95),
    max: strictDefined(sorted[sorted.length - 1], 'max measurement'),
  };
}

function unavailable(reason: string): Metric<never> {
  return { status: 'unavailable', reason };
}

async function measureStartup(hostBin: string): Promise<{ imageId: ImageIdPayload; startupOverheadMs: number }> {
  const result = await runChild(hostBin, ['--print-image-id', '--json'], process.cwd());
  if (result.exitCode !== 0) {
    throw new Error(`Failed to read host ImageID: ${tailOutput(result.stderr || result.stdout)}`);
  }
  return {
    imageId: parseImageIdPayload(result.stdout),
    startupOverheadMs: result.wallTimeMs,
  };
}

async function runProofIteration(options: BenchmarkOptions, iteration: number): Promise<RunMeasurement> {
  const runDir = await mkdtemp(path.join(tmpdir(), 'stark-ballot-zkvm-bench-'));
  const inputPath = path.join(runDir, `zkvm-bench-${options.slots}.json`);
  const outputPath = inputPath.replace('.json', '-output.json');
  const receiptPath = inputPath.replace('.json', '-receipt.json');
  const inputPayload = buildSerializedBenchmarkInput(options.slots);
  await writeFile(inputPath, `${JSON.stringify(inputPayload, null, 2)}\n`, 'utf8');

  try {
    const result = await runChild(options.hostBin, [inputPath], process.cwd());
    if (result.exitCode !== 0) {
      throw new Error(`Host proof run ${iteration} failed: ${tailOutput(result.stderr || result.stdout)}`);
    }
    parseOutputArtifact(await readFile(outputPath, 'utf8'), options.slots);
    const receiptSizeBytes = (await stat(receiptPath)).size;
    const outputSizeBytes = (await stat(outputPath)).size;

    return {
      iteration,
      inputPath,
      outputPath,
      receiptPath,
      wallTimeMs: result.wallTimeMs,
      receiptSizeBytes,
      outputSizeBytes,
      exitCode: result.exitCode,
      stdoutTail: tailOutput(result.stdout),
      stderrTail: tailOutput(result.stderr),
    };
  } finally {
    if (!options.keepArtifacts) {
      await rm(runDir, { recursive: true, force: true });
    }
  }
}

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  const hostStats = await stat(options.hostBin).catch(() => undefined);
  if (!hostStats?.isFile()) {
    throw new Error(`Host binary not found: ${options.hostBin}. Build it with pnpm build:zkvm first.`);
  }

  const inputPayload = buildSerializedBenchmarkInput(options.slots);
  const inputBytes = Buffer.byteLength(JSON.stringify(inputPayload, null, 2));
  const startup = await measureStartup(options.hostBin);
  const runs: RunMeasurement[] = [];
  for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
    runs.push(await runProofIteration(options, iteration));
  }

  return {
    schema: 'stark-ballot.zkvm-full-guest-benchmark.v1',
    generatedAt: new Date().toISOString(),
    fixture: {
      slots: options.slots,
      treeSize: options.slots,
      totalExpected: options.slots,
      inputBytes,
    },
    command: {
      hostBin: options.hostBin,
      productionMode: true,
      risc0DevMode: 'unset',
    },
    imageId: startup.imageId,
    artifactsRetained: options.keepArtifacts,
    metrics: {
      guestCycles: unavailable('The current host CLI does not expose RISC Zero guest cycle counters.'),
      executionTimeMs: unavailable('The current host CLI reports execution and proving as one combined process.'),
      proofTimeMs: unavailable('The current host CLI reports execution and proving as one combined process.'),
      combinedHostWallTimeMs: {
        status: 'measured',
        value: summarizeMeasurements(runs.map((run) => run.wallTimeMs)),
        unit: 'milliseconds',
        method: 'Node process wall time for host <input-json-file> with RISC0_DEV_MODE unset',
      },
      shaPrecompileActivity: unavailable('The current RISC Zero host output does not expose SHA precompile counters.'),
      receiptSizeBytes: {
        status: 'measured',
        value: summarizeMeasurements(runs.map((run) => run.receiptSizeBytes)),
        unit: 'bytes',
        method: 'Filesystem size of the receipt JSON artifact written by the full guest host',
      },
      hostJsonParseTimeMs: unavailable('The current host CLI does not expose Rust-side JSON parse timing.'),
      hostSerializationTimeMs: unavailable('The current host CLI does not expose Rust-side serialization timing.'),
      processStartupOverheadMs: {
        status: 'measured',
        value: startup.startupOverheadMs,
        unit: 'milliseconds',
        method: 'Node process wall time for host --print-image-id --json',
      },
    },
    runs,
  };
}

async function main(): Promise<void> {
  const options = parseBenchmarkArgs(process.argv.slice(2));
  if (options.showHelp) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const report = await runBenchmark(options);
  const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath) {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, serializedReport, 'utf8');
  }
  process.stdout.write(serializedReport);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
