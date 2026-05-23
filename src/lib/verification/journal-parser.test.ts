import { describe, it, expect } from 'vitest';
import { parseJournalBytes, formatVoteCounts } from './journal-parser';
import { CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';

const toHex = (value: number): string => value.toString(16).padStart(2, '0');

const pushArray = (target: number[], source: number[]): void => {
  target.push(...source);
};

const pushU32 = (target: number[], value: number): void => {
  target.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
};

describe('Journal Parser', () => {
  it('should parse the current journal layout with full metadata', () => {
    const bytes: number[] = [];

    const electionIdBytes = [
      0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0,
    ];
    const electionConfigHashBytes = Array.from({ length: 32 }, (_, i) => (0xa0 + i) & 0xff);
    const bulletinRootBytes = Array.from({ length: 32 }, (_, i) => (0x50 + i) & 0xff);
    const sthDigestBytes = Array.from({ length: 32 }, (_, i) => (0xb0 + i) & 0xff);
    const seenBitmapRootBytes = Array.from({ length: 32 }, (_, i) => (0x70 + i) & 0xff);
    const includedBitmapRootBytes = Array.from({ length: 32 }, (_, i) => (0xc0 + i) & 0xff);
    const inputCommitmentBytes = Array.from({ length: 32 }, (_, i) => (0xd0 + i) & 0xff);

    pushArray(bytes, electionIdBytes);
    pushArray(bytes, electionConfigHashBytes);
    pushArray(bytes, bulletinRootBytes);
    pushU32(bytes, 64); // tree_size
    pushU32(bytes, 64); // total_expected
    pushArray(bytes, sthDigestBytes);

    const tally = [10, 11, 12, 13, 14];
    tally.forEach((value) => pushU32(bytes, value));

    pushU32(bytes, 64); // total_votes
    pushU32(bytes, 64); // valid_votes
    pushU32(bytes, 0); // invalid_votes
    pushU32(bytes, 64); // seen_indices_count
    pushU32(bytes, 0); // missing_slots
    pushU32(bytes, 0); // invalid_presented_slots
    pushU32(bytes, 0); // rejected_records

    pushArray(bytes, seenBitmapRootBytes);
    pushArray(bytes, includedBitmapRootBytes);
    pushU32(bytes, 0); // excluded_slots
    pushArray(bytes, inputCommitmentBytes);
    pushU32(bytes, CURRENT_METHOD_VERSION); // method_version

    const result = parseJournalBytes(bytes);

    const expectedElectionId = '12345678-9abc-def0-1234-56789abcdef0';
    const expectedElectionConfigHash = `0x${electionConfigHashBytes.map(toHex).join('')}`;
    const expectedBulletinRoot = `0x${bulletinRootBytes.map(toHex).join('')}`;
    const expectedSTHDigest = `0x${sthDigestBytes.map(toHex).join('')}`;
    const expectedSeenBitmapRoot = `0x${seenBitmapRootBytes.map(toHex).join('')}`;
    const expectedIncludedBitmapRoot = `0x${includedBitmapRootBytes.map(toHex).join('')}`;
    const expectedInputCommitment = `0x${inputCommitmentBytes.map(toHex).join('')}`;

    expect(result.electionId).toBe(expectedElectionId);
    expect(result.electionConfigHash).toBe(expectedElectionConfigHash);
    expect(result.bulletinRoot).toBe(expectedBulletinRoot);
    expect(result.treeSize).toBe(64);
    expect(result.totalExpected).toBe(64);
    expect(result.sthDigest).toBe(expectedSTHDigest);
    expect(result.verifiedTally).toEqual(tally);
    expect(result.totalVotes).toBe(64);
    expect(result.validVotes).toBe(64);
    expect(result.invalidVotes).toBe(0);
    expect(result.seenIndicesCount).toBe(64);
    expect(result.missingSlots).toBe(0);
    expect(result.invalidPresentedSlots).toBe(0);
    expect(result.rejectedRecords).toBe(0);
    expect(result.seenBitmapRoot).toBe(expectedSeenBitmapRoot);
    expect(result.includedBitmapRoot).toBe(expectedIncludedBitmapRoot);
    expect(result.excludedSlots).toBe(0);
    expect(result.inputCommitment).toBe(expectedInputCommitment);
    expect(result.methodVersion).toBe(CURRENT_METHOD_VERSION);
    expect(result.tamperDetected).toBe(false);
  });

  it('should derive tamperDetected when excluded votes are present', () => {
    const bytes: number[] = [];

    const electionIdBytes = Array.from({ length: 16 }, () => 0x21);
    const hashBytes = Array.from({ length: 32 }, () => 0x42);
    const bulletinRootBytes = Array.from({ length: 32 }, () => 0x66);
    const sthBytes = Array.from({ length: 32 }, () => 0x77);
    const seenBitmapRootBytes = Array.from({ length: 32 }, () => 0x55);
    const bitmapRootBytes = Array.from({ length: 32 }, () => 0x88);
    const inputCommitmentBytes = Array.from({ length: 32 }, () => 0x99);

    pushArray(bytes, electionIdBytes);
    pushArray(bytes, hashBytes);
    pushArray(bytes, bulletinRootBytes);
    pushU32(bytes, 32); // tree_size
    pushU32(bytes, 32); // total_expected
    pushArray(bytes, sthBytes);

    [5, 6, 7, 8, 9].forEach((value) => pushU32(bytes, value));

    pushU32(bytes, 31); // total_votes
    pushU32(bytes, 30); // valid_votes
    pushU32(bytes, 1); // invalid_votes
    pushU32(bytes, 31); // seen_indices_count
    pushU32(bytes, 1); // missing_slots
    pushU32(bytes, 1); // invalid_presented_slots
    pushU32(bytes, 1); // rejected_records

    pushArray(bytes, seenBitmapRootBytes);
    pushArray(bytes, bitmapRootBytes);
    pushU32(bytes, 2); // excluded_slots
    pushArray(bytes, inputCommitmentBytes);
    pushU32(bytes, CURRENT_METHOD_VERSION); // method_version

    const result = parseJournalBytes(bytes);

    expect(result.tamperDetected).toBe(true);
    expect(result.excludedSlots).toBe(2);
    expect(result.rejectedRecords).toBe(1);
    expect(result.invalidPresentedSlots).toBe(1);
    expect(result.missingSlots).toBe(1);
    expect(result.seenBitmapRoot).toBe(`0x${seenBitmapRootBytes.map(toHex).join('')}`);
  });

  it('should reject legacy-sized journals without seenBitmapRoot', () => {
    const journalBytes: number[] = Array<number>(240).fill(0);

    expect(() => parseJournalBytes(journalBytes)).toThrow('Invalid journal size: expected 272 bytes, got 240');
  });

  it('should throw error for invalid journal size', () => {
    const journalBytes = [1, 2, 3, 4, 5];

    expect(() => parseJournalBytes(journalBytes)).toThrow('Invalid journal size: expected 272 bytes, got 5');
  });

  it('should reject journals with a non-current methodVersion', () => {
    const bytes: number[] = [];

    pushArray(bytes, Array<number>(16).fill(0x11));
    pushArray(bytes, Array<number>(32).fill(0x22));
    pushArray(bytes, Array<number>(32).fill(0x33));
    pushU32(bytes, 1);
    pushU32(bytes, 1);
    pushArray(bytes, Array<number>(32).fill(0x44));
    [1, 0, 0, 0, 0].forEach((value) => pushU32(bytes, value));
    pushU32(bytes, 1);
    pushU32(bytes, 1);
    pushU32(bytes, 0);
    pushU32(bytes, 1);
    pushU32(bytes, 0);
    pushU32(bytes, 0);
    pushU32(bytes, 0);
    pushArray(bytes, Array<number>(32).fill(0x55));
    pushArray(bytes, Array<number>(32).fill(0x66));
    pushU32(bytes, 0);
    pushArray(bytes, Array<number>(32).fill(0x77));
    pushU32(bytes, CURRENT_METHOD_VERSION - 1);

    expect(() => parseJournalBytes(bytes)).toThrow(`Unsupported journal method version: ${CURRENT_METHOD_VERSION - 1}`);
  });

  it('should format vote counts correctly', () => {
    const counts = [14, 13, 13, 12, 12];
    const formatted = formatVoteCounts(counts);

    expect(formatted).toEqual({
      A: 14,
      B: 13,
      C: 13,
      D: 12,
      E: 12,
    });
  });
});
