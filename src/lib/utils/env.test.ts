import { describe, expect, it } from 'vitest';
import { isTruthyFlag } from './env';

describe('isTruthyFlag', () => {
  it('returns true for supported truthy values', () => {
    expect(isTruthyFlag('1')).toBe(true);
    expect(isTruthyFlag('true')).toBe(true);
    expect(isTruthyFlag('yes')).toBe(true);
    expect(isTruthyFlag('on')).toBe(true);
    expect(isTruthyFlag(' TRUE ')).toBe(true);
    expect(isTruthyFlag('YeS')).toBe(true);
  });

  it('returns false for unsupported or empty values', () => {
    expect(isTruthyFlag(undefined)).toBe(false);
    expect(isTruthyFlag(null)).toBe(false);
    expect(isTruthyFlag('')).toBe(false);
    expect(isTruthyFlag('0')).toBe(false);
    expect(isTruthyFlag('false')).toBe(false);
    expect(isTruthyFlag('off')).toBe(false);
    expect(isTruthyFlag('no')).toBe(false);
    expect(isTruthyFlag('random')).toBe(false);
  });
});
