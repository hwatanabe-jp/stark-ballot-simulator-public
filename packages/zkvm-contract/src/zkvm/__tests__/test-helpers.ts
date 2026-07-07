import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ZkVMInput, VoteWithProof } from '../types';
import { computeCommitment } from '../types';

export function generateRandomBytes32(): string {
  return `0x${randomBytes(32).toString('hex')}`;
}

export function generateElectionConfigHash(options?: { totalExpected?: number; choices?: string[] }): string {
  const config = {
    totalExpected: options?.totalExpected ?? 64,
    choices: options?.choices ?? ['A', 'B', 'C', 'D', 'E'],
    votingPeriod: 300,
    version: 'v1.0',
  };
  const hash = createHash('sha256');
  hash.update(JSON.stringify(config));
  return `0x${hash.digest('hex')}`;
}

function merkleDepth(treeSize: number): number {
  return treeSize <= 1 ? 0 : Math.ceil(Math.log2(treeSize));
}

function createTestVoteWithProof(options: {
  electionId: string;
  choice: number;
  index: number;
  treeSize: number;
}): VoteWithProof {
  const random = generateRandomBytes32();
  return {
    commitment: computeCommitment(options.electionId, options.choice, random),
    choice: options.choice,
    random,
    index: options.index,
    merklePath: Array.from({ length: merkleDepth(options.treeSize) }, generateRandomBytes32),
  };
}

export function createTestInput(options?: {
  electionId?: string;
  voteCount?: number;
  totalExpected?: number;
  treeSize?: number;
}): ZkVMInput {
  const electionId = options?.electionId ?? randomUUID();
  const voteCount = options?.voteCount ?? 3;
  const totalExpected = options?.totalExpected ?? voteCount;
  const treeSize = options?.treeSize ?? Math.max(1, totalExpected, voteCount);
  const votes = Array.from({ length: voteCount }, (_, index) =>
    createTestVoteWithProof({
      electionId,
      choice: index % 5,
      index,
      treeSize,
    }),
  );

  return {
    electionId,
    bulletinRoot: generateRandomBytes32(),
    treeSize,
    logId: generateRandomBytes32(),
    timestamp: Date.now(),
    totalExpected,
    electionConfigHash: generateElectionConfigHash({ totalExpected }),
    votes,
  };
}
