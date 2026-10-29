import { describe, expect, it } from 'vitest';
import { generateVoteId } from './voteId';
import { isValidVoteId } from '@stark-ballot/validation/vote-id';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('vote ID generation and validation', () => {
  it('generates a UUID v4 vote ID', () => {
    expect(generateVoteId()).toMatch(UUID_V4_PATTERN);
  });

  it('accepts UUID v4 values case-insensitively', () => {
    for (const voteId of ['550e8400-e29b-41d4-a716-446655440000', 'F47AC10B-58CC-4372-A567-0E02B2C3D479']) {
      expect(isValidVoteId(voteId)).toBe(true);
    }
  });

  it('rejects malformed or unsafe vote IDs', () => {
    for (const voteId of [
      '',
      'not-a-uuid',
      '550e8400-e29b-41d4-a716',
      '550e8400-e29b-41d4-a716-446655440000-extra',
      '550e8400-e29b-XXd4-a716-446655440000',
      '550e8400-e29b-11d4-a716-446655440000',
      '550e8400-e29b-41d4-7716-446655440000',
      '../../../etc/passwd',
      'test/../../secret',
      '550e8400\\e29b\\41d4\\a716\\446655440000',
    ]) {
      expect(isValidVoteId(voteId)).toBe(false);
    }
  });
});
