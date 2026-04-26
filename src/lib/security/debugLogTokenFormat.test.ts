import { describe, it, expect } from 'vitest';
import { isDebugLogTokenFormat } from './debugLogTokenFormat';

describe('isDebugLogTokenFormat', () => {
  it('accepts a valid token format', () => {
    const token = 'v1.1735689600.debug.' + 'a'.repeat(64);

    expect(isDebugLogTokenFormat(token)).toBe(true);
  });

  it('rejects unknown versions', () => {
    const token = 'v2.1735689600.debug.' + 'a'.repeat(64);

    expect(isDebugLogTokenFormat(token)).toBe(false);
  });

  it('rejects unknown levels', () => {
    const token = 'v1.1735689600.verbose.' + 'a'.repeat(64);

    expect(isDebugLogTokenFormat(token)).toBe(false);
  });

  it('rejects invalid signatures', () => {
    const token = 'v1.1735689600.debug.1234';

    expect(isDebugLogTokenFormat(token)).toBe(false);
  });
});
