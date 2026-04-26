/**
 * Test helpers for zkVM v2 structures
 * Provides utilities for creating test data following final_design.md v1.0
 */

import { randomBytes, randomUUID } from 'crypto';
import { createHash } from 'crypto';
import type { CurrentZkVMJournal, ZkVMInput, VoteWithProof, ZkVMJournal } from '@/lib/zkvm/types';
import { CURRENT_METHOD_VERSION, computeCommitment, computeSTHDigest } from '@/lib/zkvm/types';
import { deriveLegacyJournalCountCompatibility } from '@/lib/zkvm/journal-count-compat';

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
> & {
  missingIndices?: number;
  invalidIndices?: number;
  countedIndices?: number;
  excludedCount?: number;
};

export interface NormalizedTestJournalCounts
  extends
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
    >,
    ReturnType<typeof deriveLegacyJournalCountCompatibility> {}

function selectNumber(...values: Array<number | undefined>): number | undefined {
  return values.find((value): value is number => typeof value === 'number');
}

/**
 * Normalize current-contract count mirrors for tests.
 *
 * `invalidIndices` remains a legacy slot-based alias for
 * `invalidPresentedSlots`. Record-space counts must come from
 * `rejectedRecords` / `invalidVotes`, not from that alias.
 */
export function normalizeTestJournalCounts(
  overrides: TestJournalCountInput,
  base: TestJournalCountInput = {},
): NormalizedTestJournalCounts {
  const validVotes =
    selectNumber(overrides.validVotes, overrides.countedIndices, base.validVotes, base.countedIndices, 0) ?? 0;
  const missingSlots =
    selectNumber(overrides.missingSlots, overrides.missingIndices, base.missingSlots, base.missingIndices, 0) ?? 0;
  const invalidPresentedSlots =
    selectNumber(
      overrides.invalidPresentedSlots,
      overrides.invalidIndices,
      base.invalidPresentedSlots,
      base.invalidIndices,
      0,
    ) ?? 0;
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
    selectNumber(overrides.excludedSlots, overrides.excludedCount, missingSlots + invalidPresentedSlots) ??
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
    ...deriveLegacyJournalCountCompatibility({
      validVotes,
      missingSlots,
      invalidPresentedSlots,
      excludedSlots,
    }),
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
 * Create test ZkVMInput
 */
export function createTestInput(options?: {
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

/**
 * Create test ZkVMJournal
 */
export function createTestJournal(options?: {
  electionId?: string;
  totalExpected?: number;
  validVotes?: number;
  missingSlots?: number;
  missingIndices?: number;
  invalidPresentedSlots?: number;
  invalidIndices?: number;
  rejectedRecords?: number;
  excludedSlots?: number;
  seenIndicesCount?: number;
}): CurrentZkVMJournal {
  const electionId = options?.electionId || generateElectionId();
  const totalExpected = options?.totalExpected ?? 64;
  const validVotes = options?.validVotes ?? totalExpected;
  const requestedMissingSlots = options?.missingSlots ?? options?.missingIndices;
  const requestedInvalidPresentedSlots = options?.invalidPresentedSlots ?? options?.invalidIndices;
  const requestedSeenIndicesCount = options?.seenIndicesCount;

  let seenIndicesCount: number;
  if (requestedSeenIndicesCount !== undefined) {
    seenIndicesCount = requestedSeenIndicesCount;
  } else if (requestedInvalidPresentedSlots !== undefined) {
    seenIndicesCount = validVotes + requestedInvalidPresentedSlots;
  } else {
    const missingIndices = requestedMissingSlots ?? 0;
    // Default helper fixtures still model treeSize === totalExpected. Tests that
    // need a different seen-count relationship should pass seenIndicesCount
    // explicitly instead of relying on this derivation.
    seenIndicesCount = Math.max(0, totalExpected - missingIndices);
  }

  const missingSlots = totalExpected - seenIndicesCount;
  const invalidPresentedSlots = seenIndicesCount - validVotes;

  if (seenIndicesCount > totalExpected || missingSlots < 0) {
    throw new Error('createTestJournal slot partition exceeds totalExpected');
  }

  if (invalidPresentedSlots < 0) {
    throw new Error('createTestJournal slot partition requires validVotes <= seenIndicesCount');
  }

  if (requestedInvalidPresentedSlots !== undefined && requestedInvalidPresentedSlots !== invalidPresentedSlots) {
    throw new Error('createTestJournal invalidIndices must match seenIndicesCount - validVotes');
  }

  if (requestedMissingSlots !== undefined && requestedMissingSlots !== missingSlots) {
    throw new Error('createTestJournal slot partition must match missingIndices');
  }

  if (validVotes + invalidPresentedSlots + missingSlots !== totalExpected) {
    throw new Error('createTestJournal slot partition must satisfy validVotes + invalidIndices + missingIndices');
  }

  if (options?.rejectedRecords !== undefined && options.rejectedRecords < invalidPresentedSlots) {
    throw new Error('createTestJournal rejectedRecords must be >= invalidIndices');
  }

  const normalizedCounts = normalizeTestJournalCounts({
    validVotes,
    missingSlots,
    invalidPresentedSlots,
    rejectedRecords: options?.rejectedRecords ?? invalidPresentedSlots,
    excludedSlots: options?.excludedSlots,
    seenIndicesCount,
  });

  // Generate realistic tally distribution
  const verifiedTally = generateRealisticTally(normalizedCounts.validVotes);

  // Generate hashes
  const bulletinRoot = generateRandomBytes32();
  const electionConfig = generateElectionConfig({ totalExpected });
  const sthParams = generateSTHParameters();
  const sthDigest = computeSTHDigest(sthParams.logId, totalExpected, sthParams.timestamp, bulletinRoot);

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
    seenBitmapRoot: generateRandomBytes32(),
    includedBitmapRoot: generateRandomBytes32(),
    excludedSlots: normalizedCounts.excludedSlots,
    inputCommitment: generateRandomBytes32(),
    methodVersion: CURRENT_METHOD_VERSION,
  };

  return journal;
}

/**
 * Generate realistic vote tally distribution
 */
function generateRealisticTally(totalVotes: number): number[] {
  const tally = [0, 0, 0, 0, 0];

  // Distribute votes somewhat randomly but realistically
  for (let i = 0; i < totalVotes; i++) {
    // Weighted random distribution (slight preference for middle options)
    const weights = [0.15, 0.2, 0.3, 0.2, 0.15];
    const random = Math.random();
    let cumulative = 0;

    for (let j = 0; j < 5; j++) {
      cumulative += weights[j];
      if (random < cumulative) {
        tally[j]++;
        break;
      }
    }
  }

  // Ensure the sum equals totalVotes (fix rounding issues)
  const sum = tally.reduce((a, b) => a + b, 0);
  if (sum < totalVotes) {
    tally[2] += totalVotes - sum; // Add remainder to middle option
  }

  return tally;
}
