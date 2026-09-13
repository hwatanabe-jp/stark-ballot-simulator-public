import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('schema contract helper boundary', () => {
  it('uses the stable schema descriptor instead of schema implementation definitions', () => {
    const source = readFileSync(new URL('./schemas.contract.test.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/\._def\b/u);
  });
});
