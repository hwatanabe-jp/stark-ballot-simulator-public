/**
 * Structural mock inputs and current journal fixtures for tests.
 * Use a Merkle builder when a test requires cryptographically consistent inclusion evidence.
 */

import { randomBytes, randomUUID } from 'crypto';
import { createHash } from 'crypto';
import type {
  CurrentZkVMJournal,
  VerifiedTally,
  VoteWithProof,
  ZkVMInput,
  ZkVMJournal,
} from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  CURRENT_METHOD_VERSION,
  asUnixTimestampMillis,
  computeCommitment,
  computeSTHDigest,
} from '@stark-ballot/zkvm-contract/zkvm/types';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

type TestJournalCountInput = Partial<
  Pick<
    ZkVMJournal,
    | 'totalVotes'
    | 'validVotes'
    | 'invalidVotes'
    | 'seenIndicesCount'
    | 'missingSlots'
    | 'invalidPresentedSlots'
    | 'rejectedRecords'
    | 'excludedSlots'
  >
>;

type NormalizedTestJournalCounts = Pick<
  ZkVMJournal,
  | 'totalVotes'
  | 'validVotes'
  | 'invalidVotes'
  | 'seenIndicesCount'
  | 'missingSlots'
  | 'invalidPresentedSlots'
  | 'rejectedRecords'
  | 'excludedSlots'
>;

function selectNumber(...values: Array<number | undefined>): number | undefined {
  return values.find((value): value is number => typeof value === 'number');
}

/**
 * Normalize current-contract count fields for tests.
 */
function normalizeTestJournalCounts(
  overrides: TestJournalCountInput,
  base: TestJournalCountInput = {},
): NormalizedTestJournalCounts {
  const validVotes = selectNumber(overrides.validVotes, base.validVotes, 0) ?? 0;
  const missingSlots = selectNumber(overrides.missingSlots, base.missingSlots, 0) ?? 0;
  const invalidPresentedSlots = selectNumber(overrides.invalidPresentedSlots, base.invalidPresentedSlots, 0) ?? 0;
  const rejectedRecords =
    selectNumber(
      overrides.rejectedRecords,
      overrides.invalidVotes,
      base.rejectedRecords,
      base.invalidVotes,
      invalidPresentedSlots,
    ) ?? invalidPresentedSlots;
  const invalidVotes =
    selectNumber(overrides.invalidVotes, rejectedRecords, base.invalidVotes, rejectedRecords) ?? rejectedRecords;
  const seenIndicesCount = selectNumber(overrides.seenIndicesCount, validVotes + invalidPresentedSlots) ?? 0;
  const excludedSlots =
    selectNumber(overrides.excludedSlots, base.excludedSlots, missingSlots + invalidPresentedSlots) ??
    missingSlots + invalidPresentedSlots;
  const totalVotes = selectNumber(overrides.totalVotes, validVotes + rejectedRecords) ?? validVotes + rejectedRecords;

  return {
    validVotes,
    invalidVotes,
    missingSlots,
    invalidPresentedSlots,
    rejectedRecords,
    excludedSlots,
    seenIndicesCount,
    totalVotes,
  };
}

/**
 * Generate a valid election ID (UUID v4)
 */
export function generateElectionId(): string {
  return randomUUID();
}

/**
 * Generate random 32 bytes as hex string
 */
export function generateRandomBytes32(): string {
  return '0x' + randomBytes(32).toString('hex');
}

/**
 * Create a test vote with inclusion proof
 */
export function createTestVoteWithProof(options?: {
  electionId?: string;
  choice?: number;
  random?: string;
  index?: number;
  pathLength?: number;
  treeSize?: number; // Add treeSize to calculate correct path length
}): VoteWithProof {
  const electionId = options?.electionId || generateElectionId();
  const choice = options?.choice ?? Math.floor(Math.random() * 5);
  const random = options?.random || generateRandomBytes32();
  const index = options?.index ?? 0;

  // Calculate correct path length based on tree size if provided
  let pathLength = options?.pathLength;
  if (pathLength === undefined && options?.treeSize !== undefined) {
    pathLength = calculateMerkleDepth(options.treeSize);
  } else if (pathLength === undefined) {
    pathLength = 6; // Default depth for 64 votes
  }

  // Generate commitment using v2 format with domain separation
  const commitment = computeCommitment(electionId, choice, random);

  // Generate merkle path of specified length
  const merklePath: string[] = [];
  for (let i = 0; i < pathLength; i++) {
    merklePath.push(generateRandomBytes32());
  }

  return {
    commitment,
    choice,
    random,
    index,
    merklePath,
  };
}

/**
 * Calculate required merkle tree depth for given number of leaves
 */
function calculateMerkleDepth(treeSize: number): number {
  if (treeSize <= 1) return 0;
  return Math.ceil(Math.log2(treeSize));
}

/**
 * Generate STH (Signed Tree Head) parameters
 */
export function generateSTHParameters(options?: { logId?: string; timestamp?: number }): {
  logId: string;
  timestamp: number;
} {
  const logId = options?.logId || generateDefaultLogId();
  const timestamp = options?.timestamp || Date.now();

  return {
    logId,
    timestamp,
  };
}

/**
 * Generate default log ID for bulletin board
 */
export function generateDefaultLogId(): string {
  const hash = createHash('sha256');
  hash.update('stark-ballot-bulletin-board-test-v1');
  hash.update(randomBytes(16)); // Add some randomness
  return '0x' + hash.digest('hex');
}

/**
 * Generate bulletin root from votes (simplified for testing)
 */
export function generateBulletinRoot(votes: VoteWithProof[]): string {
  const hash = createHash('sha256');

  // Sort votes by index for consistency
  const sortedVotes = [...votes].sort((a, b) => a.index - b.index);

  for (const vote of sortedVotes) {
    hash.update(Buffer.from(vote.commitment.replace(/^0x/, ''), 'hex'));
  }

  return '0x' + hash.digest('hex');
}

/**
 * Generate election configuration
 */
export function generateElectionConfig(options?: { totalExpected?: number; choices?: string[] }): {
  totalExpected: number;
  choices: string[];
  hash: string;
} {
  const totalExpected = options?.totalExpected ?? 64;
  const choices = options?.choices || ['A', 'B', 'C', 'D', 'E'];

  const config = {
    totalExpected,
    choices,
    votingPeriod: 300, // 5 minutes
    version: 'v1.0',
  };

  // Generate hash including totalExpected (MUST requirement)
  const hash = createHash('sha256');
  hash.update(JSON.stringify(config));
  const configHash = '0x' + hash.digest('hex');

  return {
    totalExpected,
    choices,
    hash: configHash,
  };
}

/**
 * Generate election config hash (convenience wrapper)
 */
export function generateElectionConfigHash(options?: { totalExpected?: number; choices?: string[] }): string {
  return generateElectionConfig(options).hash;
}

/**
 * Create a structural mock ZkVMInput; random paths and the synthetic root do not prove RFC 6962 inclusion.
 */
export function createMockZkvmInput(options?: {
  electionId?: string;
  voteCount?: number;
  totalExpected?: number;
  treeSize?: number;
}): ZkVMInput {
  const electionId = options?.electionId || generateElectionId();
  const voteCount = options?.voteCount ?? 3;
  const totalExpected = options?.totalExpected ?? voteCount;
  // Ensure treeSize is at least 1 even for empty votes
  const treeSize = options?.treeSize ?? Math.max(1, totalExpected, voteCount);

  // Generate votes
  const votes: VoteWithProof[] = [];
  for (let i = 0; i < voteCount; i++) {
    votes.push(
      createTestVoteWithProof({
        electionId,
        index: i,
        choice: i % 5, // Distribute choices
        treeSize, // Pass treeSize to get correct merkle path depth
      }),
    );
  }

  // Generate other parameters
  const bulletinRoot = generateBulletinRoot(votes);
  const sthParams = generateSTHParameters();
  const electionConfig = generateElectionConfig({ totalExpected });

  const input: ZkVMInput = {
    electionId,
    bulletinRoot,
    treeSize,
    logId: sthParams.logId,
    timestamp: sthParams.timestamp,
    totalExpected,
    electionConfigHash: electionConfig.hash,
    votes,
  };

  return input;
}

type TestJournalOptions = NonNullable<Parameters<typeof createTestJournal>[0]>;
interface TestJournalPartition {
  totalExpected: number;
  validVotes: number;
  seenIndicesCount: number;
  missingSlots: number;
  invalidPresentedSlots: number;
}

function resolveTestSeenIndicesCount(options: TestJournalOptions, totalExpected: number, validVotes: number): number {
  const requestedSeenIndicesCount = options.seenIndicesCount;
  const requestedInvalidPresentedSlots = options.invalidPresentedSlots;
  const requestedMissingSlots = options.missingSlots;
  if (requestedSeenIndicesCount !== undefined) {
    return requestedSeenIndicesCount;
  } else if (requestedInvalidPresentedSlots !== undefined) {
    return validVotes + requestedInvalidPresentedSlots;
  } else {
    const missingSlots = requestedMissingSlots ?? 0;
    // Default helper fixtures still model treeSize === totalExpected. Tests that
    // need a different seen-count relationship should pass seenIndicesCount
    // explicitly instead of relying on this derivation.
    return Math.max(0, totalExpected - missingSlots);
  }
}

function assertTestJournalSlotBounds({
  seenIndicesCount,
  totalExpected,
  missingSlots,
  invalidPresentedSlots,
}: TestJournalPartition): void {
  if (seenIndicesCount > totalExpected || missingSlots < 0) {
    throw new Error('createTestJournal slot partition exceeds totalExpected');
  }

  if (invalidPresentedSlots < 0) {
    throw new Error('createTestJournal slot partition requires validVotes <= seenIndicesCount');
  }
}

function assertRequestedTestJournalSlots(
  options: TestJournalOptions,
  { missingSlots, invalidPresentedSlots }: TestJournalPartition,
): void {
  const requestedInvalidPresentedSlots = options.invalidPresentedSlots;
  const requestedMissingSlots = options.missingSlots;
  if (requestedInvalidPresentedSlots !== undefined && requestedInvalidPresentedSlots !== invalidPresentedSlots) {
    throw new Error('createTestJournal invalidPresentedSlots must match seenIndicesCount - validVotes');
  }

  if (requestedMissingSlots !== undefined && requestedMissingSlots !== missingSlots) {
    throw new Error('createTestJournal slot partition must match missingSlots');
  }
}

function assertTestJournalCountTotals(
  options: TestJournalOptions,
  { validVotes, invalidPresentedSlots, missingSlots, totalExpected }: TestJournalPartition,
): void {
  if (validVotes + invalidPresentedSlots + missingSlots !== totalExpected) {
    throw new Error('createTestJournal slot partition must satisfy validVotes + invalidPresentedSlots + missingSlots');
  }

  if (options.rejectedRecords !== undefined && options.rejectedRecords < invalidPresentedSlots) {
    throw new Error('createTestJournal rejectedRecords must be >= invalidPresentedSlots');
  }
}

function resolveTestJournalCounts(options: TestJournalOptions) {
  const totalExpected = options.totalExpected ?? 64;
  const validVotes = options.validVotes ?? totalExpected;
  const seenIndicesCount = resolveTestSeenIndicesCount(options, totalExpected, validVotes);
  const missingSlots = totalExpected - seenIndicesCount;
  const invalidPresentedSlots = seenIndicesCount - validVotes;
  const partition = { totalExpected, validVotes, seenIndicesCount, missingSlots, invalidPresentedSlots };
  assertTestJournalSlotBounds(partition);
  assertRequestedTestJournalSlots(options, partition);
  assertTestJournalCountTotals(options, partition);
  const normalizedCounts = normalizeTestJournalCounts({
    validVotes,
    missingSlots,
    invalidPresentedSlots,
    rejectedRecords: options.rejectedRecords ?? invalidPresentedSlots,
    ...omitUndefinedProperties({ excludedSlots: options.excludedSlots }),
    seenIndicesCount,
  });

  return { totalExpected, normalizedCounts };
}

/**
 * Create test ZkVMJournal
 */
export function createTestJournal(options?: {
  electionId?: string;
  totalExpected?: number;
  validVotes?: number;
  missingSlots?: number;
  invalidPresentedSlots?: number;
  rejectedRecords?: number;
  excludedSlots?: number;
  seenIndicesCount?: number;
}): CurrentZkVMJournal {
  const electionId = options?.electionId || generateElectionId();
  const { totalExpected, normalizedCounts } = resolveTestJournalCounts(options ?? {});

  // Generate realistic tally distribution
  const verifiedTally = generateRealisticTally(normalizedCounts.validVotes);

  // Generate hashes
  const bulletinRoot = generateRandomBytes32();
  const electionConfig = generateElectionConfig({ totalExpected });
  const sthParams = generateSTHParameters();
  const sthDigest = computeSTHDigest(
    sthParams.logId,
    totalExpected,
    asUnixTimestampMillis(sthParams.timestamp),
    bulletinRoot,
  );
  const includedBitmapRoot = generateRandomBytes32();

  const journal: CurrentZkVMJournal = {
    electionId,
    electionConfigHash: electionConfig.hash,
    bulletinRoot,
    treeSize: totalExpected,
    totalExpected,
    sthDigest,
    verifiedTally,
    totalVotes: normalizedCounts.totalVotes,
    validVotes: normalizedCounts.validVotes,
    invalidVotes: normalizedCounts.invalidVotes,
    // `seenIndicesCount` tracks unique in-range indices, so rejected duplicate
    // or out-of-range records should not inflate it.
    seenIndicesCount: normalizedCounts.seenIndicesCount,
    missingSlots: normalizedCounts.missingSlots,
    invalidPresentedSlots: normalizedCounts.invalidPresentedSlots,
    rejectedRecords: normalizedCounts.rejectedRecords,
    seenBitmapRoot: normalizedCounts.invalidPresentedSlots === 0 ? includedBitmapRoot : generateRandomBytes32(),
    includedBitmapRoot,
    ...omitUndefinedProperties({ excludedSlots: normalizedCounts.excludedSlots }),
    inputCommitment: generateRandomBytes32(),
    methodVersion: CURRENT_METHOD_VERSION,
  };

  return journal;
}

/**
 * Generate realistic vote tally distribution
 */
function generateRealisticTally(totalVotes: number): VerifiedTally {
  const tally: VerifiedTally = [0, 0, 0, 0, 0];

  // Distribute votes somewhat randomly but realistically
  for (let i = 0; i < totalVotes; i++) {
    // Weighted random distribution (slight preference for middle options)
    const weights = [0.15, 0.2, 0.3, 0.2, 0.15];
    const random = Math.random();
    let cumulative = 0;

    for (let j = 0; j < 5; j++) {
      cumulative += strictDefined(weights[j]);
      if (random < cumulative) {
        tally[j] = strictDefined(tally[j]) + 1;
        break;
      }
    }
  }

  // Ensure the sum equals totalVotes (fix rounding issues)
  const sum = tally.reduce((a, b) => a + b, 0);
  if (sum < totalVotes) {
    tally[2] = strictDefined(tally[2]) + totalVotes - sum; // Add remainder to middle option
  }

  return tally;
}
