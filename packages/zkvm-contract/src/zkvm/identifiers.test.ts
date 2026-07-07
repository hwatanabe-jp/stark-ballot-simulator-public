import { describe, expect, it } from 'vitest';
import { asElectionId, asImageId, asInputCommitment, asLogId } from './identifiers';

const HEX32 = `0x${'a'.repeat(64)}`;

describe('zkVM identifier brands', () => {
  it('preserves validated wire strings at runtime', () => {
    expect(asElectionId('550e8400-e29b-41d4-a716-446655440000')).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(asLogId(HEX32)).toBe(HEX32);
    expect(asImageId(HEX32)).toBe(HEX32);
    expect(asInputCommitment(HEX32)).toBe(HEX32);
  });

  it('rejects unsafe strings before branding', () => {
    expect(() => asElectionId('not-a-uuid')).toThrow('electionId must be a UUID');
    expect(() => asInputCommitment('0xabc')).toThrow('inputCommitment must be a 32-byte hex string');
  });
});
