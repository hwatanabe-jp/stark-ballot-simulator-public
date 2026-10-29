import { describe, expect, it } from 'vitest';
import { normalizeJsonKeys } from './canonical-json';

describe('canonical JSON key ordering', () => {
  it('sorts nested objects while preserving array order and the input', () => {
    const input = { z: [{ b: 2, a: 1 }, 0], a: 'first' };
    expect(JSON.stringify(normalizeJsonKeys(input))).toBe('{"a":"first","z":[{"a":1,"b":2},0]}');
    expect(Object.keys(input)).toEqual(['z', 'a']);
  });

  it('retains prototype-named JSON fields as own data in fingerprints', () => {
    const input: unknown = JSON.parse('{"__proto__":{"polluted":true},"constructor":"field","value":1}');
    const normalized = normalizeJsonKeys(input);
    expect(JSON.stringify(normalized)).toBe('{"__proto__":{"polluted":true},"constructor":"field","value":1}');
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(Object.hasOwn(Object(normalized), '__proto__')).toBe(true);
    expect(JSON.stringify(normalizeJsonKeys({}))).not.toBe(JSON.stringify(normalized));
  });
});
