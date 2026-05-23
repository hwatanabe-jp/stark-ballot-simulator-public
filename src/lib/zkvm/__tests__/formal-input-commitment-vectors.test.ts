import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import inputCommitmentCasesJson from '../../../../docs/current/formal/generated-vectors/input-commitment-cases.json';
import {
  canonicalizeInputCommitmentVotesForEncoding,
  computeInputCommitmentFromPublicInput,
  encodeInputCommitmentPreimage,
  type InputCommitmentVote,
} from '../types';

interface FormalInputCommitmentCase {
  name: string;
  electionId: string;
  bulletinRoot: string;
  treeSize: number;
  totalExpected: number;
  votes: Array<InputCommitmentVote & { id: string }>;
  expectedCanonicalOrder: string[];
  expectedEncodedBytesHex: string;
}

const inputCommitmentCases = inputCommitmentCasesJson as FormalInputCommitmentCase[];

const voteKey = (vote: InputCommitmentVote): string => {
  return JSON.stringify({
    index: vote.index,
    commitment: vote.commitment.toLowerCase(),
    merklePath: vote.merklePath.map((node) => node.toLowerCase()),
  });
};

describe('formal input commitment vectors', () => {
  it.each(inputCommitmentCases)('$name', (testCase) => {
    const input = {
      electionId: testCase.electionId,
      bulletinRoot: testCase.bulletinRoot,
      treeSize: testCase.treeSize,
      totalExpected: testCase.totalExpected,
      votes: testCase.votes,
    };
    const voteIdsByKey = new Map(testCase.votes.map((vote) => [voteKey(vote), vote.id]));

    const canonicalOrder = canonicalizeInputCommitmentVotesForEncoding(input.votes).map((vote) => {
      const id = voteIdsByKey.get(voteKey(vote));
      if (!id) {
        throw new Error(`No formal vector vote id for canonical vote ${voteKey(vote)}`);
      }
      return id;
    });

    const encodedBytes = encodeInputCommitmentPreimage(input);
    const expectedInputCommitment = '0x' + bytesToHex(sha256(encodedBytes));

    expect(canonicalOrder).toEqual(testCase.expectedCanonicalOrder);
    expect(bytesToHex(encodedBytes)).toBe(testCase.expectedEncodedBytesHex);
    expect(computeInputCommitmentFromPublicInput(input)).toBe(expectedInputCommitment);
  });

  it('fails closed instead of truncating u32 input fields', () => {
    const baseCase = inputCommitmentCases[0];
    const baseInput = {
      electionId: baseCase.electionId,
      bulletinRoot: baseCase.bulletinRoot,
      treeSize: baseCase.treeSize,
      totalExpected: baseCase.totalExpected,
      votes: baseCase.votes,
    };

    expect(() => encodeInputCommitmentPreimage({ ...baseInput, treeSize: 0x1_0000_0000 })).toThrow(
      'treeSize must be an unsigned integer <= 4294967295',
    );
    expect(() =>
      encodeInputCommitmentPreimage({
        ...baseInput,
        votes: [{ ...baseInput.votes[0], index: 0x1_0000_0000 }],
      }),
    ).toThrow('vote index must be an unsigned integer <= 4294967295');
  });

  it('fails closed instead of truncating u16 merkle path lengths', () => {
    const baseCase = inputCommitmentCases[0];
    const baseInput = {
      electionId: baseCase.electionId,
      bulletinRoot: baseCase.bulletinRoot,
      treeSize: baseCase.treeSize,
      totalExpected: baseCase.totalExpected,
      votes: baseCase.votes,
    };
    const zeroNode = '0x' + '00'.repeat(32);

    expect(() =>
      encodeInputCommitmentPreimage({
        ...baseInput,
        votes: [{ ...baseInput.votes[0], merklePath: Array.from({ length: 0x1_0000 }, () => zeroNode) }],
      }),
    ).toThrow('vote merklePath length must be an unsigned integer <= 65535');
  });
});
