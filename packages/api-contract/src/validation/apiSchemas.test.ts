import { describe, it, expect } from 'vitest';
import {
  VoteRequestSchema,
  SessionCreateRequestSchema,
  FinalizeRequestSchema,
  VerificationRunRequestSchema,
  VerifyQuerySchema,
  ZkVMInputHashQuerySchema,
} from './apiSchemas';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

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

  it('accepts explicit Turnstile alias fields', () => {
    const result = VoteRequestSchema.safeParse({
      commitment: '0x' + 'a'.repeat(64),
      vote: 'A',
      rand: '0x' + 'b'.repeat(64),
      'cf-turnstile-response': 'token',
      cfTurnstileResponse: 'token',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unexpected fields', () => {
    const result = VoteRequestSchema.safeParse({
      commitment: '0x' + 'a'.repeat(64),
      vote: 'A',
      rand: '0x' + 'b'.repeat(64),
      verificationBundleUrl: 'https://example.invalid/bundle.zip',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid vote choice', () => {
    const result = VoteRequestSchema.safeParse({
      commitment: '0x' + 'a'.repeat(64),
      vote: 'Z',
      rand: '0x' + 'b'.repeat(64),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(strictDefined(result.error.issues[0]).path).toEqual(['vote']);
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

describe('SessionCreateRequestSchema', () => {
  it('accepts explicit Turnstile alias fields', () => {
    const result = SessionCreateRequestSchema.safeParse({
      'cf-turnstile-response': 'token',
      cfTurnstileResponse: 'token',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unexpected fields', () => {
    const result = SessionCreateRequestSchema.safeParse({ verificationBundleUrl: 'https://example.invalid' });
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

  it('accepts explicit Turnstile alias fields', () => {
    const result = FinalizeRequestSchema.safeParse({
      scenarioId: 'S0',
      'cf-turnstile-response': 'token',
      cfTurnstileResponse: 'token',
    });
    expect(result.success).toBe(true);
  });

  it('rejects payloads without scenarioId', () => {
    const result = FinalizeRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects unexpected fields', () => {
    const result = FinalizeRequestSchema.safeParse({
      scenarioId: 'S0',
      excludedCount: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('VerificationRunRequestSchema', () => {
  it('rejects non-empty payloads', () => {
    const result = VerificationRunRequestSchema.safeParse({ verificationBundleUrl: 'https://example.invalid' });
    expect(result.success).toBe(false);
  });
});

describe('VerifyQuerySchema', () => {
  it('accepts the documented journal flag only', () => {
    expect(VerifyQuerySchema.safeParse({}).success).toBe(true);
    expect(VerifyQuerySchema.safeParse({ includeJournal: '1' }).success).toBe(true);
    expect(VerifyQuerySchema.safeParse({ includeJournal: 'maybe' }).success).toBe(false);
    expect(VerifyQuerySchema.safeParse({ includeJournal: '0' }).success).toBe(false);
  });
});

describe('ZkVMInputHashQuerySchema', () => {
  it('accepts hash-only requests without includeData and rejects active-route includeData spellings', () => {
    expect(ZkVMInputHashQuerySchema.safeParse({ sessionId: 'session-123' }).success).toBe(true);
    expect(ZkVMInputHashQuerySchema.safeParse({ sessionId: 'session-123', includeData: 'maybe' }).success).toBe(false);
    expect(ZkVMInputHashQuerySchema.safeParse({ sessionId: 'session-123', includeData: 'false' }).success).toBe(false);
  });
});
