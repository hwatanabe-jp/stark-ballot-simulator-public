import { describe, it, expect } from 'vitest';
import type { VoteReceipt } from './receipt';

describe('VoteReceipt type', () => {
  it('should have all required fields', () => {
    const receipt: VoteReceipt = {
      voteId: '550e8400-e29b-41d4-a716-446655440000',
      commitment: '0xabcdef1234567890',
      bulletinIndex: 42,
      bulletinRootAtCast: '0x1234567890abcdef',
      timestamp: Date.now(),
    };

    expect(receipt.voteId).toBeDefined();
    expect(receipt.commitment).toBeDefined();
    expect(receipt.bulletinIndex).toBeDefined();
    expect(receipt.bulletinRootAtCast).toBeDefined();
    expect(receipt.timestamp).toBeDefined();
  });

  it('should support optional input commitment', () => {
    const receipt: VoteReceipt = {
      voteId: '550e8400-e29b-41d4-a716-446655440000',
      commitment: '0xabcdef',
      bulletinIndex: 0,
      bulletinRootAtCast: '0x123456',
      inputCommitment: '0xdef456',
      timestamp: 1704067200000,
    };

    expect(receipt.inputCommitment).toBe('0xdef456');
  });

  it('should support optional signature field', () => {
    const receipt: VoteReceipt = {
      voteId: '550e8400-e29b-41d4-a716-446655440000',
      commitment: '0xabcdef',
      bulletinIndex: 1,
      bulletinRootAtCast: '0x123456',
      timestamp: 1704067200000,
      signature: '0xsignature123',
    };

    expect(receipt.signature).toBe('0xsignature123');
  });

  it('should have correct field types', () => {
    const receipt: VoteReceipt = {
      voteId: '550e8400-e29b-41d4-a716-446655440000',
      commitment: '0xcommit',
      bulletinIndex: 100,
      bulletinRootAtCast: '0xroot',
      timestamp: Date.now(),
    };

    expect(typeof receipt.voteId).toBe('string');
    expect(typeof receipt.commitment).toBe('string');
    expect(typeof receipt.bulletinIndex).toBe('number');
    expect(typeof receipt.bulletinRootAtCast).toBe('string');
    expect(typeof receipt.timestamp).toBe('number');
  });
});
