import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateBotVote } from './voteGenerator';
import { VOTE_CHOICES } from '@stark-ballot/domain/shared/constants';

describe('voteGenerator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('generateBotVote', () => {
    it('generates only caller-owned bot vote fields', async () => {
      const voteData = await generateBotVote();

      expect(Object.keys(voteData).sort()).toEqual(['rand', 'vote']);
      expect(VOTE_CHOICES).toContain(voteData.vote);
      expect(voteData.rand).toMatch(/^0x[0-9a-f]{64}$/u);
    });

    it.each(VOTE_CHOICES.map((choice, index) => [choice, index] as const))(
      'maps the admitted random bucket to choice %s',
      async (choice, index) => {
        vi.spyOn(Math, 'random').mockReturnValue((index + 0.5) / VOTE_CHOICES.length);

        await expect(generateBotVote()).resolves.toMatchObject({ vote: choice });
      },
    );
  });
});
