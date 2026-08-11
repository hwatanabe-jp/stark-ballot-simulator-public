import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { CurrentZkVMJournal, ZkVMInput, VoteWithProof } from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  CURRENT_METHOD_VERSION,
  asUnixTimestampMillis,
  computeCommitment,
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

type TestInputOptions = {
  electionId?: string;
  voteCount?: number;
  totalExpected?: number;
  treeSize?: number;
};

function generateElectionId(): string {
  return randomUUID();
}

function generateRandomBytes32(): string {
  return `0x${randomBytes(32).toString('hex')}`;
}

function calculateMerkleDepth(treeSize: number): number {
  return treeSize <= 1 ? 0 : Math.ceil(Math.log2(treeSize));
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

function generateBulletinRoot(votes: VoteWithProof[]): string {
  const hash = createHash('sha256');
  for (const vote of [...votes].sort((left, right) => left.index - right.index)) {
    hash.update(Buffer.from(vote.commitment.replace(/^0x/, ''), 'hex'));
  }
  return `0x${hash.digest('hex')}`;
}

function createTestVoteWithProof(options: {
  electionId: string;
  choice: number;
  index: number;
  treeSize: number;
}): VoteWithProof {
  const random = generateRandomBytes32();
  const merklePath = Array.from({ length: calculateMerkleDepth(options.treeSize) }, generateRandomBytes32);
  return {
    commitment: computeCommitment(options.electionId, options.choice, random),
    choice: options.choice,
    random,
    index: options.index,
    merklePath,
  };
}

function buildTally(validVotes: number): number[] {
  const tally = [0, 0, 0, 0, 0];
  for (let index = 0; index < validVotes; index++) {
    const tallyIndex = index % tally.length;
    tally[tallyIndex] = strictDefined(tally[tallyIndex]) + 1;
  }
  return tally;
}

export function createTestInput(options: TestInputOptions = {}): ZkVMInput {
  const electionId = options.electionId ?? generateElectionId();
  const voteCount = options.voteCount ?? 3;
  const totalExpected = options.totalExpected ?? voteCount;
  const treeSize = options.treeSize ?? Math.max(1, totalExpected, voteCount);
  const votes = Array.from({ length: voteCount }, (_, index) =>
    createTestVoteWithProof({
      electionId,
      choice: index % 5,
      index,
      treeSize,
    }),
  );
  const bulletinRoot = generateBulletinRoot(votes);
  const logId = generateRandomBytes32();
  const timestamp = Date.now();

  return {
    electionId,
    bulletinRoot,
    treeSize,
    logId,
    timestamp,
    totalExpected,
    electionConfigHash: generateElectionConfigHash(totalExpected),
    votes,
  };
}

export function createTestJournal(options: TestJournalOptions = {}): CurrentZkVMJournal {
  const electionId = options.electionId ?? generateElectionId();
  const totalExpected = options.totalExpected ?? 64;
  const validVotes = options.validVotes ?? totalExpected;
  const requestedMissingSlots = options.missingSlots;
  const requestedInvalidPresentedSlots = options.invalidPresentedSlots;
  const seenIndicesCount =
    options.seenIndicesCount ??
    (requestedInvalidPresentedSlots !== undefined
      ? validVotes + requestedInvalidPresentedSlots
      : totalExpected - (requestedMissingSlots ?? 0));
  const missingSlots = totalExpected - seenIndicesCount;
  const invalidPresentedSlots = seenIndicesCount - validVotes;

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

  const bulletinRoot = generateRandomBytes32();
  const logId = generateRandomBytes32();
  const timestamp = Date.now();

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
    seenBitmapRoot: generateRandomBytes32(),
    includedBitmapRoot: generateRandomBytes32(),
    excludedSlots: options.excludedSlots ?? missingSlots + invalidPresentedSlots,
    inputCommitment: generateRandomBytes32(),
    methodVersion: CURRENT_METHOD_VERSION,
  };
}
