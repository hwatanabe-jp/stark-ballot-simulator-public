import { describe, expect, it } from 'vitest';
import { addHexPrefix, hexToBytesStrict, isValidHexString, normalizeHexString, sha256Hex } from './index';

describe('generic hex primitives', () => {
  it.each([
    ['', ''],
    ['0x', ''],
    ['0X', ''],
    ['ABcd', 'abcd'],
    ['0xABcd', 'abcd'],
    ['0XABcd', 'abcd'],
    ['a', 'a'],
    ['gg', 'gg'],
  ])('normalizes %j without validating it', (value, expected) => {
    expect(normalizeHexString(value)).toBe(expected);
  });

  it.each([
    ['', '0x'],
    ['0x', '0x'],
    ['0X', '0x'],
    ['ABcd', '0xabcd'],
    ['0xABcd', '0xabcd'],
    ['0XABcd', '0xabcd'],
    ['a', '0xa'],
    ['gg', '0xgg'],
  ])('adds one lowercase prefix to %j without validating it', (value, expected) => {
    expect(addHexPrefix(value)).toBe(expected);
  });

  it('preserves the current permissive no-length validation behavior', () => {
    expect(isValidHexString('')).toBe(false);
    expect(isValidHexString('0x')).toBe(true);
    expect(isValidHexString('0X')).toBe(true);
    expect(isValidHexString('a')).toBe(true);
    expect(isValidHexString('0xa')).toBe(true);
    expect(isValidHexString('ABcd')).toBe(true);
    expect(isValidHexString('gg')).toBe(false);
  });

  it('validates exact byte length when requested', () => {
    expect(isValidHexString('0x', 2)).toBe(false);
    expect(isValidHexString('a', 2)).toBe(false);
    expect(isValidHexString('ABcd', 2)).toBe(true);
    expect(isValidHexString('0xABcd', 2)).toBe(true);
    expect(isValidHexString('0XABcd', 2)).toBe(true);
    expect(isValidHexString('abcd', 1)).toBe(false);
  });

  it('strictly decodes prefixed and unprefixed bytes', () => {
    expect(hexToBytesStrict('ABcd')).toEqual(Uint8Array.of(0xab, 0xcd));
    expect(hexToBytesStrict('0xABcd')).toEqual(Uint8Array.of(0xab, 0xcd));
    expect(hexToBytesStrict('0XABcd')).toEqual(Uint8Array.of(0xab, 0xcd));
  });

  it('keeps strict decode error precedence and messages exact', () => {
    expect(() => hexToBytesStrict('')).toThrow(new Error('Invalid hex string: empty'));
    expect(() => hexToBytesStrict('0x')).toThrow(new Error('Invalid hex string: empty'));
    expect(() => hexToBytesStrict('a')).toThrow(new Error('Invalid hex string: odd length'));
    expect(() => hexToBytesStrict('0xa')).toThrow(new Error('Invalid hex string: odd length'));
    expect(() => hexToBytesStrict('g')).toThrow(new Error('Invalid hex string: odd length'));
    expect(() => hexToBytesStrict('gg')).toThrow(new Error('Invalid hex string'));
    expect(() => hexToBytesStrict('0xgg')).toThrow(new Error('Invalid hex string'));
  });
});

describe('generic SHA-256 primitive', () => {
  it('hashes empty input to the reviewed SHA-256 vector', () => {
    expect(sha256Hex()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes sequential chunks as exact byte concatenation with lowercase output', () => {
    expect(sha256Hex(Uint8Array.of(0), Uint8Array.of(1, 2))).toBe(
      'ae4b3280e56e2faf83f414a6e3dabe9d5fbe18976544c05fed121accb85b53fc',
    );
  });
});
