import { describe, expect, it } from 'vitest';
import { normalizeHex, normalizeHexOrZero, zeroHex } from './hex';

describe('normalizeHex', () => {
  it('pads, lowercases, and keeps prefix by default', () => {
    expect(normalizeHex('0xAb', { length: 4 })).toBe('0x00ab');
  });

  it('does not truncate values longer than the target length', () => {
    expect(normalizeHex('0x1234', { length: 2 })).toBe('0x1234');
  });

  it('allows odd-length values by default', () => {
    expect(normalizeHex('0', { length: 2 })).toBe('0x00');
  });

  it('rejects odd-length values when configured', () => {
    expect(() => normalizeHex('0', { length: 2, allowOddLength: false })).toThrow();
  });

  it('rejects empty values by default', () => {
    expect(() => normalizeHex('', { length: 2 })).toThrow();
  });

  it('accepts empty values when configured', () => {
    expect(normalizeHex('', { length: 4, allowEmpty: true })).toBe('0x0000');
    expect(normalizeHex('0x', { length: 2, allowEmpty: true })).toBe('0x00');
  });

  it('returns without prefix when requested', () => {
    expect(normalizeHex('0x0a', { length: 4, prefix: false })).toBe('000a');
  });
});

describe('normalizeHexOrZero', () => {
  it('returns zero when value is undefined, null, or empty', () => {
    expect(normalizeHexOrZero(undefined, { length: 4 })).toBe('0x0000');
    expect(normalizeHexOrZero(null, { length: 4 })).toBe('0x0000');
    expect(normalizeHexOrZero('', { length: 4 })).toBe('0x0000');
  });

  it('normalizes non-empty values', () => {
    expect(normalizeHexOrZero('0x1', { length: 2 })).toBe('0x01');
  });
});

describe('zeroHex', () => {
  it('returns a zero-filled hex string with prefix by default', () => {
    expect(zeroHex()).toBe('0x' + '0'.repeat(64));
  });

  it('returns a zero-filled hex string without prefix when requested', () => {
    expect(zeroHex(4, false)).toBe('0000');
  });
});
