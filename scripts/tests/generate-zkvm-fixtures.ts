#!/usr/bin/env tsx

/**
 * Fixture generator for zkVM host inputs (Phase 8 structure).
 *
 * Produces two JSON fixtures:
 *  - test-valid.json: Fully valid votes that should pass zkVM verification
 *  - test-tampered.json: Same input with a corrupted Merkle proof to trigger invalidPresentedSlots
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RFC6962MerkleTree } from '@/lib/merkle/rfc6962-merkle-tree';
import { serializeZkvmAggregatorInput } from '@/lib/zkvm/executor';
import type { ZkVMInput, VoteWithProof } from '@/lib/zkvm/types';
import { computeCommitment, computeSTHDigest } from '@/lib/zkvm/types';
import { generateElectionConfigHash } from '@/lib/testing/test-helpers';
import { addHexPrefix } from '@/lib/utils/hex';

const OUTPUT_DIR = path.resolve(__dirname, '../../zkvm/test-data');

type HexString = `0x${string}`;

const ELECTION_ID: string = '550e8400-e29b-41d4-a716-446655440000';
const TOTAL_VOTES = 8;

const RANDOM_VALUES: HexString[] = [];
for (let i = 0; i < TOTAL_VOTES; i += 1) {
  RANDOM_VALUES.push(`0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}`);
}

const CHOICES = [0, 1, 2, 3, 4, 0, 1, 2];

function bufferToHex(buf: Buffer): HexString {
  return `0x${buf.toString('hex')}`;
}

function buildVotes(): {
  votes: VoteWithProof[];
  bulletinRoot: HexString;
} {
  const commitments: HexString[] = RANDOM_VALUES.map(
    (rand, i) => computeCommitment(ELECTION_ID, CHOICES[i], rand) as HexString,
  );
  const tree = new RFC6962MerkleTree();
  for (const commitment of commitments) {
    tree.append(commitment);
  }

  const votes: VoteWithProof[] = commitments.map((commitment, index) => ({
    commitment,
    choice: CHOICES[index],
    random: RANDOM_VALUES[index],
    index,
    merklePath: tree.getInclusionProof(index, commitments.length).proofNodes.map((node) => addHexPrefix(node)),
  }));

  return {
    votes,
    bulletinRoot: addHexPrefix(tree.getRoot()) as HexString,
  };
}

function buildInput(): ZkVMInput {
  const { votes, bulletinRoot } = buildVotes();
  const logId = computeLogId();
  const timestamp = 1_725_000_000;
  const totalExpected = votes.length;
  const electionConfigHash = generateElectionConfigHash({ totalExpected });

  return {
    electionId: ELECTION_ID,
    bulletinRoot,
    treeSize: votes.length,
    logId,
    timestamp,
    totalExpected,
    electionConfigHash,
    votes,
  };
}

function computeLogId(): HexString {
  const hash = createHash('sha256');
  hash.update('stark-ballot:fixture-log');
  return bufferToHex(hash.digest());
}

function generateFixtures() {
  const input = buildInput();

  const sthDigest = computeSTHDigest(input.logId, input.treeSize, input.timestamp, input.bulletinRoot);

  console.log('Expected STH digest:', sthDigest);

  const validJson = serializeZkvmAggregatorInput(input);

  const tamperedInput: ZkVMInput = {
    ...input,
    votes: input.votes.map((vote, index) =>
      index === 0 && vote.merklePath.length > 0
        ? {
            ...vote,
            merklePath: ['0x' + '00'.repeat(32), ...vote.merklePath.slice(1)],
          }
        : vote,
    ),
  };
  const tamperedJson = serializeZkvmAggregatorInput(tamperedInput);

  writeFileSync(path.join(OUTPUT_DIR, 'test-fixture-valid.json'), JSON.stringify(validJson, null, 2));
  writeFileSync(path.join(OUTPUT_DIR, 'test-fixture-tampered.json'), JSON.stringify(tamperedJson, null, 2));
}

generateFixtures();
