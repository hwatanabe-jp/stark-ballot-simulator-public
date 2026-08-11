import { describe, expect, it } from 'vitest';
import { generateFinalizationId } from './finalization-id';

describe('generateFinalizationId', () => {
  it('creates a sortable safe finalization identifier', () => {
    const finalizationId = generateFinalizationId(1_730_000_000_000);

    expect(finalizationId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(finalizationId).toHaveLength(26);
  });
});
