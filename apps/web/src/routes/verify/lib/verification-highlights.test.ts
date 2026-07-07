import { describe, expect, it } from 'vitest';
import { DEFAULT_VERIFICATION_HIGHLIGHTS, resolveHighlightedKnowledge } from './verification-highlights';

describe('resolveHighlightedKnowledge', () => {
  it('uses API inputs when provided', () => {
    const result = resolveHighlightedKnowledge('cast_as_intended', [
      { id: 'cast_as_intended', inputs: ['electionId', 'user.choice'] },
    ]);

    expect(result).toEqual(['electionId', 'user.choice']);
  });

  it('falls back to defaults when inputs are empty', () => {
    const result = resolveHighlightedKnowledge('recorded_as_cast', [{ id: 'recorded_as_cast', inputs: [] }]);

    expect(result).toEqual(DEFAULT_VERIFICATION_HIGHLIGHTS.recorded_as_cast);
  });

  it('falls back to defaults when API steps are missing', () => {
    const result = resolveHighlightedKnowledge('stark_verification', undefined);

    expect(result).toEqual(DEFAULT_VERIFICATION_HIGHLIGHTS.stark_verification);
  });
});
