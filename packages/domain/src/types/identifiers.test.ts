import { describe, expect, it } from 'vitest';
import { asBulletinIndex, asLeafIndex, asSessionId, asVoteIndex } from './identifiers';

describe('domain identifier brands', () => {
  it('preserves safe string values at runtime', () => {
    expect(asSessionId('session-1')).toBe('session-1');
    expect(asVoteIndex(0)).toBe(0);
    expect(asBulletinIndex(42)).toBe(42);
    expect(asLeafIndex(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects unsafe boundary values before branding', () => {
    expect(() => asVoteIndex(-1)).toThrow('voteIndex must be a non-negative safe integer');
    expect(() => asBulletinIndex(1.5)).toThrow('bulletinIndex must be a non-negative safe integer');
    expect(() => asLeafIndex(Number.MAX_SAFE_INTEGER + 1)).toThrow('leafIndex must be a non-negative safe integer');
  });
});
