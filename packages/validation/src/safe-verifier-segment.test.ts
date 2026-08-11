import { describe, expect, it } from 'vitest';
import {
  assertSafeVerifierSegment,
  isSafeVerifierSegment,
  SAFE_VERIFIER_SEGMENT_PATTERN,
} from './safe-verifier-segment';

describe('safe verifier segments', () => {
  it.each([
    ['single letter', 'a'],
    ['single digit', '0'],
    ['hyphenated session identifier', 'session-123'],
    ['UUID session identifier', '550e8400-e29b-41d4-a716-446655440000'],
    ['finalization identifier', 'exec-123456'],
    ['uppercase identifier', 'FINALIZATION-ABC-123'],
  ])('accepts a valid %s', (_label, value) => {
    expect(isSafeVerifierSegment(value)).toBe(true);
    expect(SAFE_VERIFIER_SEGMENT_PATTERN.test(value)).toBe(true);
  });

  it('preserves the current absence of a neutral length limit', () => {
    expect(isSafeVerifierSegment('a'.repeat(257))).toBe(true);
    expect(isSafeVerifierSegment('a'.repeat(4096))).toBe(true);
  });

  it.each([
    ['empty value', ''],
    ['forward slash', 'session/123'],
    ['backslash', String.raw`session\123`],
    ['single traversal dot', '.'],
    ['double traversal dots', '..'],
    ['embedded dot', 'session.123'],
    ['percent-encoded slash', 'session%2F123'],
    ['double-encoded slash', 'session%252F123'],
    ['percent-encoded dot', 'session%2E123'],
    ['space', 'session 123'],
    ['underscore', 'session_123'],
    ['non-ASCII text', 'セッション'],
    ['null control character', 'session\u0000'],
    ['line feed', 'session\n'],
    ['carriage return', 'session\r'],
    ['tab', 'session\t'],
    ['delete control character', 'session\u007f'],
  ])('rejects an invalid %s', (_label, value) => {
    expect(isSafeVerifierSegment(value)).toBe(false);
    expect(SAFE_VERIFIER_SEGMENT_PATTERN.test(value)).toBe(false);
  });

  it('preserves the canonical assertion error', () => {
    expect(() => assertSafeVerifierSegment('../finalization', 'finalizationId')).toThrow(
      'finalizationId must be a safe single path segment',
    );
  });
});
