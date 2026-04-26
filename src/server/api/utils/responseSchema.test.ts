import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { respondWithSchema } from './responseSchema';

describe('respondWithSchema', () => {
  it('returns the schema-parsed payload instead of the original response object', async () => {
    const schema = z.object({
      data: z.object({
        id: z.string(),
      }),
    });

    const response = respondWithSchema(schema, {
      data: {
        id: 'current-response',
        excludedCount: 1,
      },
      verificationBundleUrl: 'https://example.invalid/bundle.zip',
    });

    await expect(response.json()).resolves.toEqual({
      data: {
        id: 'current-response',
      },
    });
  });
});
