#!/usr/bin/env tsx

import { performance } from 'node:perf_hooks';
import { DuplicateDetector } from '@stark-ballot/validation/duplicate-detector';
import { RFC6962MerkleTree } from '@stark-ballot/merkle/rfc6962-merkle-tree';
import { BatchProcessor } from './batch-processor';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

type BenchmarkRow = {
  name: string;
  iterations: number;
  medianMs: string;
  minMs: string;
  maxMs: string;
};

const DEFAULT_ITERATIONS = 20;
const WARMUP_ITERATIONS = 3;

function isIterationFlag(value: string): boolean {
  if (!value) return false;
  return value === '--iterations' || value === '-n' || value.startsWith('--iterations=');
}

function readIterationArgument(argv: string[]): string | undefined {
  const index = argv.findIndex(isIterationFlag);
  const token = argv[index];
  if (!token) return undefined;
  if (token.startsWith('--iterations=')) return token.slice('--iterations='.length);
  return argv[index + 1];
}

function parseIterationCount(): number {
  const argv = process.argv.slice(2).filter((value) => value !== '--');
  const rawIterations = readIterationArgument(argv);

  if (!rawIterations) {
    return DEFAULT_ITERATIONS;
  }

  const parsed = Number.parseInt(rawIterations, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid iterations value: ${rawIterations}`);
  }

  return parsed;
}

function formatDuration(value: number): string {
  return value.toFixed(3);
}

function summarizeDurations(name: string, durations: number[]): BenchmarkRow {
  const sorted = [...durations].sort((left, right) => left - right);
  if (sorted.length === 0) {
    throw new Error('Cannot summarize an empty duration set');
  }
  const middleIndex = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (strictDefined(sorted[middleIndex - 1]) + strictDefined(sorted[middleIndex])) / 2
      : strictDefined(sorted[middleIndex]);

  return {
    name,
    iterations: durations.length,
    medianMs: formatDuration(median),
    minMs: formatDuration(strictDefined(sorted[0])),
    maxMs: formatDuration(strictDefined(sorted[sorted.length - 1])),
  };
}

function buildDuplicateVotes(size: number): Array<{ voteId: string; commitment: string }> {
  const votes = Array.from({ length: size }, (_, index) => ({
    voteId: `vote-${index}`,
    commitment: `0x${index.toString(16).padStart(64, '0')}`,
  }));

  const firstDuplicate = votes[Math.floor(size / 2)];
  const secondDuplicate = votes[Math.floor((size * 3) / 4)];
  if (!firstDuplicate || !secondDuplicate) {
    throw new Error('Duplicate vote fixtures were not generated');
  }
  votes.push(firstDuplicate);
  votes.push(secondDuplicate);

  return votes;
}

function measureSync(name: string, iterations: number, fn: () => void): Promise<BenchmarkRow> {
  for (let index = 0; index < WARMUP_ITERATIONS; index++) {
    fn();
  }

  const durations: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    fn();
    durations.push(performance.now() - start);
  }

  return Promise.resolve(summarizeDurations(name, durations));
}

async function measureAsync(name: string, iterations: number, fn: () => Promise<void>): Promise<BenchmarkRow> {
  for (let index = 0; index < WARMUP_ITERATIONS; index++) {
    await fn();
  }

  const durations: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    await fn();
    durations.push(performance.now() - start);
  }

  return summarizeDurations(name, durations);
}

async function runBenchmarks(iterations: number): Promise<BenchmarkRow[]> {
  const duplicateVotes = buildDuplicateVotes(1_000);
  const merkleTree = new RFC6962MerkleTree();
  for (let index = 0; index < 512; index++) {
    merkleTree.append(index.toString(16).padStart(64, '0'));
  }
  const historicalRoot = merkleTree.getRootAtSize(250);

  const batchItems = Array.from({ length: 1_000 }, (_, index) => index);

  return Promise.all([
    measureSync('duplicate-detector.checkBatch(1002 votes)', iterations, () => {
      const detector = new DuplicateDetector();
      const result = detector.checkBatch(duplicateVotes);
      if (result.duplicateCount !== 2 || result.uniqueCount !== 1_000) {
        throw new Error('Duplicate detector benchmark sanity check failed');
      }
    }),
    measureSync('ct-merkle.getInclusionProof(size=512)', iterations, () => {
      const proof = merkleTree.getInclusionProof(100, 512);
      if (proof.proofNodes.length === 0) {
        throw new Error('Merkle proof benchmark sanity check failed');
      }
    }),
    measureSync('ct-merkle.clearCache + getRootAtSize(250)', iterations, () => {
      merkleTree.clearCache();
      if (merkleTree.getRootAtSize(250) !== historicalRoot) {
        throw new Error('Uncached historical root benchmark sanity check failed');
      }
    }),
    measureSync('ct-merkle.getRootAtSize(250), cached', iterations, () => {
      if (merkleTree.getRootAtSize(250) !== historicalRoot) {
        throw new Error('Cached historical root benchmark sanity check failed');
      }
    }),
    measureAsync('batch-processor.processBatch(1000 items)', iterations, async () => {
      const processor = new BatchProcessor(4);
      let processed = 0;
      await processor.processBatch(batchItems, () => {
        processed += 1;
      });
      if (processed !== batchItems.length) {
        throw new Error('Batch processor benchmark sanity check failed');
      }
    }),
  ]);
}

async function main(): Promise<void> {
  const iterations = parseIterationCount();
  const rows = await runBenchmarks(iterations);

  console.log(`Performance benchmark summary (${iterations} measured iterations, ${WARMUP_ITERATIONS} warmup runs)`);
  console.table(rows);
  console.log('These results are advisory only and are intentionally excluded from pnpm test:run.');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
