import { createHash, randomBytes } from 'node:crypto';
import type { VoteWithProof } from '@stark-ballot/zkvm-contract/zkvm/types';
import { computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';

function generateRandomBytes32(): string {
  return `0x${randomBytes(32).toString('hex')}`;
}

export function generateDefaultLogId(): string {
  const hash = createHash('sha256');
  hash.update('stark-ballot-bulletin-board-test-v1');
  hash.update(randomBytes(16));
  return `0x${hash.digest('hex')}`;
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

export function createTestVoteWithProof(options: {
  electionId: string;
  choice?: number;
  random?: string;
  index?: number;
  pathLength?: number;
  treeSize?: number;
}): VoteWithProof {
  const choice = options.choice ?? 0;
  const random = options.random ?? generateRandomBytes32();
  const index = options.index ?? 0;
  const pathLength =
    options.pathLength ??
    (options.treeSize === undefined || options.treeSize <= 1 ? 0 : Math.ceil(Math.log2(options.treeSize)));

  return {
    commitment: computeCommitment(options.electionId, choice, random),
    choice,
    random,
    index,
    merklePath: Array.from({ length: pathLength }, generateRandomBytes32),
  };
}
