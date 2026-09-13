import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { RFC6962MerkleTree } from '@stark-ballot/merkle/rfc6962-merkle-tree';
import { executeZkVM as executeRisc0ZkVM } from '@stark-ballot/node-adapters/zkvm/executor';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { buildDefaultElectionConfig, hashElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import {
  asUnixTimestampMillis,
  computeCommitment,
  computeInputCommitment,
  computeSTHDigest,
  CURRENT_METHOD_VERSION,
  type ZkVMInput,
  type VoteWithProof,
} from '@stark-ballot/zkvm-contract/zkvm/types';

const BOT_COUNT = 63;
const ELECTION_ID = '550e8400-e29b-41d4-a716-446655440000';
const TIMESTAMP = asUnixTimestampMillis(1_767_225_600_000);
const DEVELOPMENT_PROOF_PROFILE = {
  executor: 'risc0',
  evidence: 'development',
} as const;

function createInput(choices: number[]): ZkVMInput {
  const tree = new RFC6962MerkleTree();
  const votes: VoteWithProof[] = choices.map((choice, index) => {
    const random = `0x${(index + 1).toString(16).padStart(64, '0')}`;
    const commitment = computeCommitment(ELECTION_ID, choice, random);
    tree.append(commitment);
    return { choice, commitment, random, index, merklePath: [] };
  });

  for (const vote of votes) {
    vote.merklePath = tree.getInclusionProof(vote.index).proofNodes.map((node) => `0x${node}`);
  }

  return {
    votes,
    bulletinRoot: `0x${tree.getRoot()}`,
    treeSize: tree.size,
    totalExpected: tree.size,
    electionId: ELECTION_ID,
    electionConfigHash: hashElectionConfig(buildDefaultElectionConfig()),
    logId: `0x${'ab'.repeat(32)}`,
    timestamp: TIMESTAMP,
  };
}

async function executeZkVM(input: ZkVMInput, includedBitmap: boolean[], seenBitmap: boolean[]) {
  const result = await executeRisc0ZkVM(input, DEVELOPMENT_PROOF_PROFILE);

  expect(result).toMatchObject({
    electionId: input.electionId,
    electionConfigHash: input.electionConfigHash,
    bulletinRoot: input.bulletinRoot,
    treeSize: input.treeSize,
    totalExpected: input.totalExpected,
    methodVersion: CURRENT_METHOD_VERSION,
    inputCommitment: computeInputCommitment(input),
    sthDigest: computeSTHDigest(input.logId, input.treeSize, TIMESTAMP, input.bulletinRoot),
    includedBitmap,
    seenBitmap,
    includedBitmapRoot: computeIncludedBitmapRoot(includedBitmap),
    seenBitmapRoot: computeIncludedBitmapRoot(seenBitmap),
  });

  return result;
}

describe('zkVM development receipt end-to-end execution', () => {
  beforeAll(() => {
    const hostPath = path.join(process.cwd(), 'zkvm/target/release/host');
    if (!existsSync(hostPath)) {
      throw new Error('zkVM host binary not found. Please run: pnpm build:zkvm:dev-mode');
    }
  });

  it('counts every valid vote using the current commitment and CT inclusion contract', async () => {
    const input = createInput([0, ...Array.from({ length: BOT_COUNT }, (_, index) => index % 5)]);
    const allIncluded = Array.from({ length: BOT_COUNT + 1 }, () => true);

    const result = await executeZkVM(input, allIncluded, allIncluded);

    expect(result).toMatchObject({
      verifiedTally: [14, 13, 13, 12, 12],
      totalVotes: 64,
      validVotes: 64,
      invalidVotes: 0,
      seenIndicesCount: 64,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      rejectedRecords: 0,
      excludedSlots: 0,
    });
  }, 180_000);

  it('reports an omitted ballot as a missing slot while retaining the full bulletin root', async () => {
    const input = createInput(Array.from({ length: BOT_COUNT + 1 }, () => 2));
    input.votes = input.votes.slice(1);
    const remainingIncluded = [false, ...Array.from({ length: BOT_COUNT }, () => true)];

    const result = await executeZkVM(input, remainingIncluded, remainingIncluded);

    expect(result).toMatchObject({
      verifiedTally: [0, 0, 63, 0, 0],
      totalVotes: 63,
      validVotes: 63,
      invalidVotes: 0,
      seenIndicesCount: 63,
      missingSlots: 1,
      invalidPresentedSlots: 0,
      rejectedRecords: 0,
      excludedSlots: 1,
    });
  }, 180_000);

  it('rejects an invalid opening while counting the other proof-bound votes', async () => {
    const input = createInput(Array.from({ length: BOT_COUNT + 1 }, () => 1));
    input.votes = input.votes.map((vote) => (vote.index === 0 ? { ...vote, random: `0x${'ff'.repeat(32)}` } : vote));
    const includedBitmap = [false, ...Array.from({ length: BOT_COUNT }, () => true)];
    const seenBitmap = Array.from({ length: BOT_COUNT + 1 }, () => true);

    const result = await executeZkVM(input, includedBitmap, seenBitmap);

    expect(result).toMatchObject({
      verifiedTally: [0, 63, 0, 0, 0],
      totalVotes: 64,
      validVotes: 63,
      invalidVotes: 1,
      seenIndicesCount: 64,
      missingSlots: 0,
      invalidPresentedSlots: 1,
      rejectedRecords: 1,
      excludedSlots: 1,
    });
  }, 180_000);

  it('rejects a tampered CT path even when the vote opening is valid', async () => {
    const input = createInput(Array.from({ length: BOT_COUNT + 1 }, () => 4));
    input.votes = input.votes.map((vote) =>
      vote.index === 0 ? { ...vote, merklePath: [`0x${'ff'.repeat(32)}`, ...vote.merklePath.slice(1)] } : vote,
    );
    const includedBitmap = [false, ...Array.from({ length: BOT_COUNT }, () => true)];
    const seenBitmap = Array.from({ length: BOT_COUNT + 1 }, () => true);

    const result = await executeZkVM(input, includedBitmap, seenBitmap);

    expect(result).toMatchObject({
      verifiedTally: [0, 0, 0, 0, 63],
      totalVotes: 64,
      validVotes: 63,
      invalidVotes: 1,
      seenIndicesCount: 64,
      missingSlots: 0,
      invalidPresentedSlots: 1,
      rejectedRecords: 1,
      excludedSlots: 1,
    });
  }, 180_000);
});
