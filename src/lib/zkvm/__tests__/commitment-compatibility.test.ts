/**
 * Integration test to verify TypeScript and Rust commitment implementations
 * produce identical results
 */

import { describe, it, expect } from 'vitest';
import { computeCommitment } from '../types';

describe('Commitment TypeScript-Rust Compatibility', () => {
  it('should match Rust implementation for test vector 1', () => {
    const electionId = '550e8400-e29b-41d4-a716-446655440000';
    const choice = 0;
    const random = '0x' + 'aa'.repeat(32);

    const commitment = computeCommitment(electionId, choice, random);

    // This is the expected value that Rust tests verify against
    expect(commitment).toBe('0x561b8d0fd296c8b0aed2aa6f655d330282f455780fc828e7b6bb660744598e88');
  });

  it('should match Rust implementation for test vector 2', () => {
    const electionId = '123e4567-e89b-12d3-a456-426614174000';
    const choice = 3;
    const random = '0x' + '01'.repeat(32);

    const commitment = computeCommitment(electionId, choice, random);

    expect(commitment).toBe('0x59d37c6c8f05e1e82a45804364a06e9692613f0c5ef127e590045146c5f1e403');
  });

  it('should match Rust implementation for test vector 3', () => {
    const electionId = '00000000-0000-0000-0000-000000000000';
    const choice = 2;
    const random = '0x' + '00'.repeat(32);

    const commitment = computeCommitment(electionId, choice, random);

    expect(commitment).toBe('0x98690a4a49b9188a48e47f4a50dfb11645c151aec264ce7348ef9f65b6a9fa03');
  });

  it('should handle all valid choice values (0-4)', () => {
    const electionId = 'abcdef12-3456-7890-abcd-ef1234567890';
    const random = '0x' + 'ff'.repeat(32);

    const choices = [0, 1, 2, 3, 4]; // Options A-E
    const commitments = choices.map((choice) => computeCommitment(electionId, choice, random));

    // All commitments should be different
    const uniqueCommitments = new Set(commitments);
    expect(uniqueCommitments.size).toBe(5);

    // All should be valid hex strings
    commitments.forEach((commitment) => {
      expect(commitment).toMatch(/^0x[0-9a-f]{64}$/i);
    });
  });

  it('should produce different commitments for different elections', () => {
    const electionId1 = '11111111-1111-1111-1111-111111111111';
    const electionId2 = '22222222-2222-2222-2222-222222222222';
    const choice = 1;
    const random = '0x' + 'ab'.repeat(32);

    const commitment1 = computeCommitment(electionId1, choice, random);
    const commitment2 = computeCommitment(electionId2, choice, random);

    expect(commitment1).not.toBe(commitment2);
  });

  it('should be deterministic', () => {
    const electionId = 'deadbeef-dead-beef-dead-beefdeadbeef';
    const choice = 4;
    const random = '0x' + '42'.repeat(32);

    const commitment1 = computeCommitment(electionId, choice, random);
    const commitment2 = computeCommitment(electionId, choice, random);
    const commitment3 = computeCommitment(electionId, choice, random);

    expect(commitment1).toBe(commitment2);
    expect(commitment2).toBe(commitment3);
  });
});
