import { serializeZkvmAggregatorInput } from '../host-io';
import { toValidatedZkVMInput } from '../validated-domain';
import type { ZkVMInput } from '../types';

const VALID_INPUT: ZkVMInput = {
  electionId: '550e8400-e29b-41d4-a716-446655440000',
  bulletinRoot: `0x${'11'.repeat(32)}`,
  treeSize: 2,
  logId: `0x${'22'.repeat(32)}`,
  timestamp: 1_700_000_000_000,
  totalExpected: 2,
  electionConfigHash: `0x${'33'.repeat(32)}`,
  votes: [
    {
      commitment: `0x${'44'.repeat(32)}`,
      choice: 7,
      random: `0x${'55'.repeat(32)}`,
      index: 1,
      merklePath: [`0x${'66'.repeat(32)}`],
    },
  ],
};

describe('validated zkVM domain boundary', () => {
  it('keeps valid wire input serializing deterministically after validation', () => {
    expect(toValidatedZkVMInput(VALID_INPUT)).toMatchObject({
      electionId: VALID_INPUT.electionId,
      treeSize: VALID_INPUT.treeSize,
      votes: [{ choice: 7, index: 1 }],
    });

    expect(serializeZkvmAggregatorInput(VALID_INPUT)).toEqual({
      election_id: [0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4, 0xa7, 0x16, 0x44, 0x66, 0x55, 0x44, 0x00, 0x00],
      bulletin_root: Array.from({ length: 32 }, () => 0x11),
      tree_size: 2,
      log_id: Array.from({ length: 32 }, () => 0x22),
      timestamp: 1_700_000_000_000,
      total_expected: 2,
      election_config_hash: Array.from({ length: 32 }, () => 0x33),
      votes: [
        {
          commitment: Array.from({ length: 32 }, () => 0x44),
          choice: 7,
          random: Array.from({ length: 32 }, () => 0x55),
          index: 1,
          merkle_path: [Array.from({ length: 32 }, () => 0x66)],
        },
      ],
    });
  });

  it('rejects malformed high-value fields before host serialization', () => {
    const firstVote = VALID_INPUT.votes[0];
    if (!firstVote) {
      throw new Error('Expected VALID_INPUT to include at least one vote');
    }

    expect(() =>
      toValidatedZkVMInput({
        ...VALID_INPUT,
        bulletinRoot: `0x${'00'.repeat(32)}`,
      }),
    ).toThrow('bulletinRoot must be non-zero');

    expect(() =>
      toValidatedZkVMInput({
        ...VALID_INPUT,
        votes: [{ ...firstVote, merklePath: ['0x1234'] }],
      }),
    ).toThrow('merklePath node must be a 32-byte hex string');
  });
});
