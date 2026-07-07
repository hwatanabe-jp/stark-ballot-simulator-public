import { describe, expect, it } from 'vitest';
import { s } from '@stark-ballot/validation/schema';
import { respondWithSchema } from './responseSchema';

describe('respondWithSchema', () => {
  it('rejects response payloads with unexpected public fields', async () => {
    const schema = s
      .object({
        data: s.object({
          id: s.string(),
        }),
      })
      .strict();

    const response = respondWithSchema(schema, {
      data: {
        id: 'current-response',
      },
      verificationBundleUrl: 'https://example.invalid/bundle.zip',
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: 'INTERNAL_ERROR',
      details: 'Response schema validation failed',
    });
  });

  it('rejects nested unexpected public fields when the nested response schema is strict', async () => {
    const schema = s
      .object({
        data: s
          .object({
            id: s.string(),
          })
          .strict(),
      })
      .strict();

    const response = respondWithSchema(schema, {
      data: {
        id: 'current-response',
        privateArtifact: 'input.json',
      },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: 'INTERNAL_ERROR',
      details: 'Response schema validation failed',
    });
  });
});
