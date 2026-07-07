import { describe, it, expect } from 'vitest';
import type { VoteData } from './server';

describe('VoteData type', () => {
  it('should include voteId field', () => {
    const voteData: VoteData = {
      voteId: '550e8400-e29b-41d4-a716-446655440000',
      vote: 'A',
      rand: '0x1234567890abcdef',
      commit: '0xabcdef1234567890',
      path: ['0x111', '0x222', '0x333'],
      timestamp: Date.now(),
    };

    expect(voteData.voteId).toBeDefined();
    expect(typeof voteData.voteId).toBe('string');
  });

  it('should include timestamp field', () => {
    const now = Date.now();
    const voteData: VoteData = {
      voteId: '550e8400-e29b-41d4-a716-446655440000',
      vote: 'B',
      rand: '0x1234567890abcdef',
      commit: '0xabcdef1234567890',
      path: [],
      timestamp: now,
    };

    expect(voteData.timestamp).toBeDefined();
    expect(voteData.timestamp).toBe(now);
    expect(typeof voteData.timestamp).toBe('number');
  });

  it('should maintain existing fields', () => {
    const voteData: VoteData = {
      voteId: '550e8400-e29b-41d4-a716-446655440000',
      vote: 'C',
      rand: '0xrandom',
      commit: '0xcommitment',
      path: ['0xnode1'],
      timestamp: 1704067200000,
    };

    // All original fields should still exist
    expect(voteData.vote).toBe('C');
    expect(voteData.rand).toBe('0xrandom');
    expect(voteData.commit).toBe('0xcommitment');
    expect(voteData.path).toHaveLength(1);
  });

  it('should carry CT tree size without storing a proof mode tag', () => {
    const voteData: VoteData = {
      voteId: '550e8400-e29b-41d4-a716-446655440000',
      vote: 'D',
      rand: '0xrandom',
      commit: '0xcommitment',
      path: [],
      treeSize: 64,
    };

    expect(voteData.treeSize).toBe(64);
    expect(voteData).not.toHaveProperty('proofMode');
  });
});
