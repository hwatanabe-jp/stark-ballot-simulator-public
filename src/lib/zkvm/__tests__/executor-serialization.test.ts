import { Buffer } from 'buffer';
import { describe, it, expect } from 'vitest';
import type { ZkVMInput } from '../types';
import { serializeZkvmAggregatorInput } from '../executor';

describe('serializeZkvmAggregatorInput', () => {
  it('serializes full zkVM input for host execution', () => {
    const input: ZkVMInput = {
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      bulletinRoot: '0x' + '11'.repeat(32),
      treeSize: 4,
      totalExpected: 4,
      logId: '0x' + '22'.repeat(32),
      timestamp: 1_725_000_000,
      electionConfigHash: '0x' + '33'.repeat(32),
      votes: [
        {
          commitment: '0x' + '44'.repeat(32),
          choice: 2,
          random: '0x' + '55'.repeat(32),
          index: 3,
          merklePath: ['0x' + '66'.repeat(32), '0x' + '77'.repeat(32)],
        },
      ],
    };

    const serialized = serializeZkvmAggregatorInput(input);

    expect(serialized.election_id).toHaveLength(16);
    expect(serialized.election_id).toEqual(Buffer.from('550e8400e29b41d4a716446655440000', 'hex').toJSON().data);
    expect(serialized.bulletin_root).toEqual(Buffer.from('11'.repeat(32), 'hex').toJSON().data);
    expect(serialized.total_expected).toBe(4);
    expect(serialized.tree_size).toBe(4);
    expect(serialized.log_id).toEqual(Buffer.from('22'.repeat(32), 'hex').toJSON().data);
    expect(serialized.timestamp).toBe(1_725_000_000);
    expect(serialized.election_config_hash).toEqual(Buffer.from('33'.repeat(32), 'hex').toJSON().data);

    expect(serialized.votes).toHaveLength(1);
    const vote = serialized.votes[0];
    expect(vote.choice).toBe(2);
    expect(vote.index).toBe(3);
    expect(vote.commitment).toEqual(Buffer.from('44'.repeat(32), 'hex').toJSON().data);
    expect(vote.random).toEqual(Buffer.from('55'.repeat(32), 'hex').toJSON().data);
    expect(vote.merkle_path).toHaveLength(2);
    expect(vote.merkle_path[0]).toEqual(Buffer.from('66'.repeat(32), 'hex').toJSON().data);
    expect(vote.merkle_path[1]).toEqual(Buffer.from('77'.repeat(32), 'hex').toJSON().data);
  });
});
