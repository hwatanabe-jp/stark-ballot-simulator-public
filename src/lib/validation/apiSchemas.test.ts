import { describe, it, expect } from 'vitest';
import { VoteRequestSchema, FinalizeRequestSchema } from './apiSchemas';

describe('VoteRequestSchema', () => {
  it('accepts valid vote payloads', () => {
    const result = VoteRequestSchema.safeParse({
      commitment: '0x' + 'a'.repeat(64),
      vote: 'A',
      rand: '0x' + 'b'.repeat(64),
      turnstileToken: 'token',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid vote choice', () => {
    const result = VoteRequestSchema.safeParse({
      commitment: '0x' + 'a'.repeat(64),
      vote: 'Z',
      rand: '0x' + 'b'.repeat(64),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['vote']);
    }
  });

  it('rejects commitment with invalid length', () => {
    const result = VoteRequestSchema.safeParse({
      commitment: '0x' + 'a'.repeat(62),
      vote: 'A',
      rand: '0x' + 'b'.repeat(64),
    });
    expect(result.success).toBe(false);
  });

  it('rejects rand with invalid hex characters', () => {
    const result = VoteRequestSchema.safeParse({
      commitment: '0x' + 'a'.repeat(64),
      vote: 'A',
      rand: '0x' + 'g'.repeat(64),
    });
    expect(result.success).toBe(false);
  });
});

describe('FinalizeRequestSchema', () => {
  it('accepts scenarioId payload', () => {
    const result = FinalizeRequestSchema.safeParse({
      scenarioId: 'S0',
    });
    expect(result.success).toBe(true);
  });

  it('rejects payloads without scenarioId', () => {
    const result = FinalizeRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
