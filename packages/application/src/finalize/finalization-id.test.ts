import { describe, expect, it } from 'vitest';
import { asFinalizationId, generateFinalizationId, parseFinalizationId } from './finalization-id';

describe('generateFinalizationId', () => {
  it('creates a sortable safe finalization identifier', () => {
    const finalizationId = generateFinalizationId(1_730_000_000_000);

    expect(finalizationId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('admits the current safe-segment storage and wire shape', () => {
    for (const value of ['01JCAQ6A00ABCDEFGHJKMNPQRS', 'finalization-1']) {
      expect(parseFinalizationId(value)).toBe(value);
      expect(asFinalizationId(value)).toBe(value);
    }

    for (const invalid of ['', '../01JCAQ6A00ABCDEFGHJKMNPQRS', 'finalization_1', 'finalization 1']) {
      expect(parseFinalizationId(invalid)).toBeUndefined();
      expect(() => asFinalizationId(invalid)).toThrow('Invalid finalizationId');
    }
  });
});
