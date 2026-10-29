import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { CurrentZkVMJournal, VerifiedTally } from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  CURRENT_METHOD_VERSION,
  asUnixTimestampMillis,
  computeSTHDigest,
} from '@stark-ballot/zkvm-contract/zkvm/types';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

type TestJournalOptions = {
  electionId?: string;
  totalExpected?: number;
  validVotes?: number;
  missingSlots?: number;
  invalidPresentedSlots?: number;
  rejectedRecords?: number;
  excludedSlots?: number;
  seenIndicesCount?: number;
};

function generateElectionId(): string {
  return randomUUID();
}

function generateRandomBytes32(): string {
  return `0x${randomBytes(32).toString('hex')}`;
}

function generateElectionConfigHash(totalExpected: number): string {
  const config = {
    totalExpected,
    choices: ['A', 'B', 'C', 'D', 'E'],
    votingPeriod: 300,
    version: 'v1.0',
  };
  const hash = createHash('sha256');
  hash.update(JSON.stringify(config));
  return `0x${hash.digest('hex')}`;
}

function buildTally(validVotes: number): VerifiedTally {
  const tally: VerifiedTally = [0, 0, 0, 0, 0];
  for (let index = 0; index < validVotes; index++) {
    const tallyIndex = index % tally.length;
    tally[tallyIndex] = strictDefined(tally[tallyIndex]) + 1;
  }
  return tally;
}

function resolveTestSeenCount(options: TestJournalOptions, validVotes: number, totalExpected: number): number {
  return (
    options.seenIndicesCount ??
    (options.invalidPresentedSlots !== undefined
      ? validVotes + options.invalidPresentedSlots
      : totalExpected - (options.missingSlots ?? 0))
  );
}

function resolveTestJournalPartition(options: TestJournalOptions) {
  const totalExpected = options.totalExpected ?? 64;
  const validVotes = options.validVotes ?? totalExpected;
  const seenIndicesCount = resolveTestSeenCount(options, validVotes, totalExpected);
  const missingSlots = totalExpected - seenIndicesCount;
  const invalidPresentedSlots = seenIndicesCount - validVotes;

  validateTestJournalPartition(options, {
    totalExpected,
    validVotes,
    seenIndicesCount,
    missingSlots,
    invalidPresentedSlots,
  });

  return { totalExpected, validVotes, seenIndicesCount, missingSlots, invalidPresentedSlots };
}

function validateTestJournalPartition(
  options: TestJournalOptions,
  counts: {
    totalExpected: number;
    validVotes: number;
    seenIndicesCount: number;
    missingSlots: number;
    invalidPresentedSlots: number;
  },
): void {
  const { totalExpected, seenIndicesCount, missingSlots, invalidPresentedSlots } = counts;
  const requestedMissingSlots = options.missingSlots;
  const requestedInvalidPresentedSlots = options.invalidPresentedSlots;
  if (seenIndicesCount > totalExpected || missingSlots < 0) {
    throw new Error('createTestJournal slot partition exceeds totalExpected');
  }
  if (invalidPresentedSlots < 0) {
    throw new Error('createTestJournal slot partition requires validVotes <= seenIndicesCount');
  }
  if (requestedMissingSlots !== undefined && requestedMissingSlots !== missingSlots) {
    throw new Error('createTestJournal slot partition must match missingSlots');
  }
  if (requestedInvalidPresentedSlots !== undefined && requestedInvalidPresentedSlots !== invalidPresentedSlots) {
    throw new Error('createTestJournal invalidPresentedSlots must match seenIndicesCount - validVotes');
  }
}

export function createTestJournal(options: TestJournalOptions = {}): CurrentZkVMJournal {
  const electionId = options.electionId ?? generateElectionId();
  const { totalExpected, validVotes, seenIndicesCount, missingSlots, invalidPresentedSlots } =
    resolveTestJournalPartition(options);

  const bulletinRoot = generateRandomBytes32();
  const logId = generateRandomBytes32();
  const timestamp = Date.now();
  const includedBitmapRoot = generateRandomBytes32();

  return {
    electionId,
    electionConfigHash: generateElectionConfigHash(totalExpected),
    bulletinRoot,
    treeSize: totalExpected,
    totalExpected,
    sthDigest: computeSTHDigest(logId, totalExpected, asUnixTimestampMillis(timestamp), bulletinRoot),
    verifiedTally: buildTally(validVotes),
    totalVotes: validVotes + (options.rejectedRecords ?? invalidPresentedSlots),
    validVotes,
    invalidVotes: options.rejectedRecords ?? invalidPresentedSlots,
    seenIndicesCount,
    missingSlots,
    invalidPresentedSlots,
    rejectedRecords: options.rejectedRecords ?? invalidPresentedSlots,
    seenBitmapRoot: invalidPresentedSlots === 0 ? includedBitmapRoot : generateRandomBytes32(),
    includedBitmapRoot,
    excludedSlots: options.excludedSlots ?? missingSlots + invalidPresentedSlots,
    inputCommitment: generateRandomBytes32(),
    methodVersion: CURRENT_METHOD_VERSION,
  };
}
