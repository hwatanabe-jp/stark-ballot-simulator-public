/**
 * TypeScript-Rust exact-current contract parity tests.
 *
 * Independent STH and vote-commitment vectors are mirrored in
 * zkvm/methods/guest/src/cross_language_vectors_test.rs. Generated formal
 * vectors own input-commitment and bitmap correspondence.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import type { ZkVMInput, VoteWithProof } from './types';
import { asUnixTimestampMillis, computeSTHDigest, computeInputCommitment, computeCommitment } from './types';
import { computeIncludedBitmapRoot } from './bitmap';
import { computeIncludedBitmapRootHex } from './bitmap-core';

const APPROVED_RUST_AGGREGATOR_INPUT_FIELDS = [
  'election_id',
  'bulletin_root',
  'tree_size',
  'log_id',
  'timestamp',
  'total_expected',
  'election_config_hash',
  'votes',
] as const;

const APPROVED_TS_ZKVM_INPUT_FIELDS = [
  'electionId',
  'bulletinRoot',
  'treeSize',
  'logId',
  'timestamp',
  'totalExpected',
  'electionConfigHash',
  'votes',
] as const;

const APPROVED_RUST_VERIFICATION_OUTPUT_FIELDS = [
  'election_id',
  'election_config_hash',
  'bulletin_root',
  'tree_size',
  'total_expected',
  'sth_digest',
  'verified_tally',
  'total_votes',
  'valid_votes',
  'invalid_votes',
  'seen_indices_count',
  'missing_slots',
  'invalid_presented_slots',
  'rejected_records',
  'seen_bitmap_root',
  'included_bitmap_root',
  'excluded_slots',
  'input_commitment',
  'method_version',
] as const;

const APPROVED_TS_ZKVM_JOURNAL_FIELDS = [
  'electionId',
  'electionConfigHash',
  'bulletinRoot',
  'treeSize',
  'totalExpected',
  'sthDigest',
  'verifiedTally',
  'totalVotes',
  'validVotes',
  'invalidVotes',
  'seenIndicesCount',
  'missingSlots',
  'invalidPresentedSlots',
  'rejectedRecords',
  'seenBitmapRoot',
  'includedBitmapRoot',
  'excludedSlots',
  'inputCommitment',
  'methodVersion',
] as const;

function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

function requireBlock(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern);
  const block = match?.[1];
  if (block === undefined) {
    throw new Error(`Could not find ${label}`);
  }
  return block;
}

function extractRustStructBody(source: string, structName: string): string {
  return requireBlock(source, new RegExp(`pub struct ${structName} \\{([\\s\\S]*?)\\n\\}`), structName);
}

function extractRustStructFieldsFromBody(body: string, structName: string): string[] {
  return [...body.matchAll(/^\s+pub\s+([a-zA-Z0-9_]+):/gm)].map((match) => {
    const field = match[1];
    if (field === undefined) {
      throw new Error(`Malformed Rust field in ${structName}`);
    }
    return field;
  });
}

function extractTsInterfaceFields(
  source: string,
  interfaceName: string,
  excludedFields: readonly string[] = [],
): string[] {
  const body = requireBlock(
    source,
    new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`),
    interfaceName,
  );
  return [...body.matchAll(/^\s+([A-Za-z0-9_]+)\??:/gm)]
    .map((match) => {
      const field = match[1];
      if (field === undefined) {
        throw new Error(`Malformed TypeScript field in ${interfaceName}`);
      }
      return field;
    })
    .filter((field) => !excludedFields.includes(field));
}

describe('TypeScript-Rust Compatibility', () => {
  describe('Input contract structure', () => {
    it('keeps AggregatorInput and ZkVMInput on the approved proof-input field lists', () => {
      const rustTypes = readRepoFile('zkvm/contract-core/src/types.rs');
      const tsTypes = readRepoFile('packages/zkvm-contract/src/zkvm/types.ts');
      const rustAggregatorInputBody = extractRustStructBody(rustTypes, 'AggregatorInput');

      expect(extractRustStructFieldsFromBody(rustAggregatorInputBody, 'AggregatorInput')).toEqual([
        ...APPROVED_RUST_AGGREGATOR_INPUT_FIELDS,
      ]);
      expect(extractTsInterfaceFields(tsTypes, 'ZkVMInput')).toEqual([...APPROVED_TS_ZKVM_INPUT_FIELDS]);
    });
  });

  describe('Journal contract structure', () => {
    it('keeps VerificationOutput and ZkVMJournal on the approved public field list', () => {
      const rustTypes = readRepoFile('zkvm/contract-core/src/types.rs');
      const tsTypes = readRepoFile('packages/zkvm-contract/src/zkvm/types.ts');
      const guestMain = readRepoFile('zkvm/methods/guest/src/main.rs');
      const rustVerificationOutputBody = extractRustStructBody(rustTypes, 'VerificationOutput');

      expect(extractRustStructFieldsFromBody(rustVerificationOutputBody, 'VerificationOutput')).toEqual([
        ...APPROVED_RUST_VERIFICATION_OUTPUT_FIELDS,
      ]);
      expect(extractTsInterfaceFields(tsTypes, 'ZkVMJournal', ['imageId'])).toEqual([
        ...APPROVED_TS_ZKVM_JOURNAL_FIELDS,
      ]);

      for (const legacyField of [
        'merkle_root',
        'tamper_detected',
        'missing_indices',
        'invalid_indices',
        'counted_indices',
        'excluded_count',
        'original_choices',
        'tampered_choices',
        'affected_indices',
      ]) {
        expect(rustVerificationOutputBody).not.toContain(legacyField);
      }

      for (const witnessLeakPattern of [
        /println!.*\b(choice|random)\b/,
        /eprintln!.*\b(choice|random)\b/,
        /env::commit.*\b(choice|random)\b/,
        /journal.*\b(choice|random)\b/,
      ]) {
        expect(guestMain).not.toMatch(witnessLeakPattern);
      }
      expect(guestMain).toContain('env::commit(&output)');
    });
  });

  describe('STH Digest Compatibility', () => {
    it('should match Rust STH digest calculation', () => {
      // Fixed test case that should work with both implementations
      const logId = '0x' + '01'.repeat(32);
      const treeSize = 64;
      const timestamp = 1_234_567_890_000; // Fixed Unix timestamp in milliseconds
      const bulletinRoot = '0x' + 'aa'.repeat(32);

      const sthDigest = computeSTHDigest(logId, treeSize, asUnixTimestampMillis(timestamp), bulletinRoot);

      expect(sthDigest).toBe('0xaedbecefc2c4aec2f8b73a44af53a4d87fc20567d74802c608b5069d26f19e18');

      // Verify determinism
      const sthDigest2 = computeSTHDigest(logId, treeSize, asUnixTimestampMillis(timestamp), bulletinRoot);
      expect(sthDigest2).toBe(sthDigest);
    });

    it('should produce different digests for different timestamps', () => {
      const logId = '0x' + '02'.repeat(32);
      const treeSize = 32;
      const bulletinRoot = '0x' + 'bb'.repeat(32);

      const digest1 = computeSTHDigest(logId, treeSize, asUnixTimestampMillis(1_000_000_000_000), bulletinRoot);
      const digest2 = computeSTHDigest(logId, treeSize, asUnixTimestampMillis(2_000_000_000_000), bulletinRoot);

      expect(digest1).not.toBe(digest2);
    });
  });

  describe('Input Commitment Compatibility', () => {
    it('should match Rust input commitment calculation', () => {
      // Create a minimal test case
      const electionId = '550e8400-e29b-41d4-a716-446655440000';
      const bulletinRoot = '0x' + '11'.repeat(32);
      const treeSize = 1;
      const totalExpected = 1;

      const vote: VoteWithProof = {
        commitment: computeCommitment(electionId, 0, '0x' + 'ff'.repeat(32)),
        choice: 0,
        random: '0x' + 'ff'.repeat(32),
        index: 0,
        merklePath: [],
      };

      const input: ZkVMInput = {
        electionId,
        bulletinRoot,
        treeSize,
        logId: '0x' + '22'.repeat(32),
        timestamp: 1_234_567_890_000,
        totalExpected,
        electionConfigHash: '0x' + '33'.repeat(32),
        votes: [vote],
      };

      const inputCommitment = computeInputCommitment(input);

      expect(inputCommitment).toBe('0xbeaa8d53c5c49f3bf66ed3910a96e0c382b5efbb2fc5d37e0f87c9b5b708a100');
    });

    it('should apply canonical vote ordering before hashing', () => {
      const electionId = '123e4567-e89b-12d3-a456-426614174000';
      const bulletinRoot = '0x' + '44'.repeat(32);
      const treeSize = 10;
      const totalExpected = 10;

      // Create votes in non-sorted order
      const vote1: VoteWithProof = {
        commitment: computeCommitment(electionId, 1, '0x' + '01'.repeat(32)),
        choice: 1,
        random: '0x' + '01'.repeat(32),
        index: 5,
        merklePath: [],
      };

      const vote2: VoteWithProof = {
        commitment: computeCommitment(electionId, 2, '0x' + '02'.repeat(32)),
        choice: 2,
        random: '0x' + '02'.repeat(32),
        index: 2,
        merklePath: [],
      };

      const vote3: VoteWithProof = {
        commitment: computeCommitment(electionId, 0, '0x' + '03'.repeat(32)),
        choice: 0,
        random: '0x' + '03'.repeat(32),
        index: 8,
        merklePath: [],
      };

      // Test with different orderings
      const input1: ZkVMInput = {
        electionId,
        bulletinRoot,
        treeSize,
        logId: '0x' + '55'.repeat(32),
        timestamp: 1_234_567_890_000,
        totalExpected,
        electionConfigHash: '0x' + '66'.repeat(32),
        votes: [vote1, vote2, vote3], // Order: 5, 2, 8
      };

      const input2: ZkVMInput = {
        ...input1,
        votes: [vote3, vote1, vote2], // Order: 8, 5, 2
      };

      const inputCommitment1 = computeInputCommitment(input1);
      const inputCommitment2 = computeInputCommitment(input2);

      expect(inputCommitment1).toBe('0x41b500cbc58e121a4b0b03ee386073b739293f9397b1cd75b0bdf555c1afb32d');
      // Both should produce the same result due to canonical ordering.
      expect(inputCommitment1).toBe(inputCommitment2);
    });

    it('should match Rust duplicate-index tie-break vector', () => {
      const electionId = '550e8400-e29b-41d4-a716-446655440000';
      const bulletinRoot = '0x' + '11'.repeat(32);
      const treeSize = 8;
      const totalExpected = 3;

      const input: ZkVMInput = {
        electionId,
        bulletinRoot,
        treeSize,
        logId: '0x' + '22'.repeat(32),
        timestamp: 1_234_567_890_000,
        totalExpected,
        electionConfigHash: '0x' + '33'.repeat(32),
        votes: [
          {
            commitment: '0x' + '22'.repeat(32),
            choice: 0,
            random: '0x' + 'aa'.repeat(32),
            index: 3,
            merklePath: ['0x' + '44'.repeat(32)],
          },
          {
            commitment: '0x' + '11'.repeat(32),
            choice: 1,
            random: '0x' + 'bb'.repeat(32),
            index: 3,
            merklePath: ['0x' + '55'.repeat(32)],
          },
          {
            commitment: '0x' + '11'.repeat(32),
            choice: 2,
            random: '0x' + 'cc'.repeat(32),
            index: 3,
            merklePath: ['0x' + '33'.repeat(32)],
          },
        ],
      };

      expect(computeInputCommitment(input)).toBe('0xd097e151b6e9e86146be5af1a0d0df53512898f675a33bc28e88e90612181f60');
    });
  });

  describe('Included Bitmap Root Compatibility', () => {
    it('should match Rust bitmap root calculation for single byte', () => {
      // Test with 8 bits (1 byte)
      const bitmap: boolean[] = [
        true, // index 0
        false, // index 1
        true, // index 2
        true, // index 3
        false, // index 4
        false, // index 5
        true, // index 6
        false, // index 7
      ];

      const expectedRoot = '0xe4018e05fd184227db0b71514ec035dbe036ebdea6360eb572ac801aff35e753';
      expect(computeIncludedBitmapRoot(bitmap)).toBe(expectedRoot);
      expect(computeIncludedBitmapRootHex(bitmap)).toBe(expectedRoot);
    });

    it('should handle partial bytes correctly', () => {
      // Test with 12 bits (1.5 bytes)
      const bitmap = Array.from({ length: 12 }, () => false);
      bitmap[0] = true;
      bitmap[3] = true;
      bitmap[11] = true;

      // Expected: 0b00001001 0b00001000 (LSB first)
      // Byte 0: 0x09, Byte 1: 0x08

      expect(computeIncludedBitmapRoot(bitmap)).toBe(
        '0x6e1d0752358a72b5be5fa226f517f005b7b5b785965ac1f1ca67902478b6fc10',
      );
    });

    it('should handle multiple chunks correctly', () => {
      // Test with 257 bits (requires 2 Merkle tree leaves)
      const bitmap = Array.from({ length: 257 }, () => false);
      bitmap[0] = true; // First chunk
      bitmap[256] = true; // Second chunk

      expect(computeIncludedBitmapRoot(bitmap)).toBe(
        '0x0054a5e06904125fb9adb5b7ce8388312f3fd36642f1bb628551f8aeb6773456',
      );
    });
  });

  describe('Commitment Compatibility', () => {
    it('should match Rust commitment vector', () => {
      const electionId = '550e8400-e29b-41d4-a716-446655440000';
      const choice = 0;
      const random = '0x' + 'aa'.repeat(32);

      expect(computeCommitment(electionId, choice, random)).toBe(
        '0x561b8d0fd296c8b0aed2aa6f655d330282f455780fc828e7b6bb660744598e88',
      );
    });
  });
});
