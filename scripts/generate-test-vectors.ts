#!/usr/bin/env npx tsx
/**
 * Generate comprehensive test vectors for the current implementation
 * Ensures TypeScript and Rust implementations produce identical results
 * for STHDigest, inputCommitment, and includedBitmapRoot
 */

import {
  computeSTHDigest,
  computeInputCommitment,
  computeCommitment,
  type ZkVMInput,
  type VoteWithProof,
} from '../src/lib/zkvm/types';
import { createHash } from 'crypto';

console.log('===== Test Vectors for TypeScript-Rust Compatibility =====\n');

// Test Vector 1: STH Digest
console.log('=== Test Vector 1: STH Digest ===');
const logId1 = '0x' + '01'.repeat(32);
const treeSize1 = 64;
const timestamp1 = 1234567890;
const bulletinRoot1 = '0x' + 'aa'.repeat(32);

const sthDigest1 = computeSTHDigest(logId1, treeSize1, timestamp1, bulletinRoot1);

console.log('Input:');
console.log('  logId:', logId1);
console.log('  treeSize:', treeSize1);
console.log('  timestamp:', timestamp1);
console.log('  bulletinRoot:', bulletinRoot1);
console.log('Output:');
console.log('  sthDigest:', sthDigest1);
console.log();

// Test Vector 2: Input Commitment (minimal)
console.log('=== Test Vector 2: Input Commitment (minimal) ===');
const electionId2 = '550e8400-e29b-41d4-a716-446655440000';
const bulletinRoot2 = '0x' + '11'.repeat(32);
const treeSize2 = 1;
const totalExpected2 = 1;

const vote2: VoteWithProof = {
  commitment: computeCommitment(electionId2, 0, '0x' + 'ff'.repeat(32)),
  choice: 0,
  random: '0x' + 'ff'.repeat(32),
  index: 0,
  merklePath: [],
};

const input2: ZkVMInput = {
  electionId: electionId2,
  bulletinRoot: bulletinRoot2,
  treeSize: treeSize2,
  logId: '0x' + '22'.repeat(32),
  timestamp: 1234567890,
  totalExpected: totalExpected2,
  electionConfigHash: '0x' + '33'.repeat(32),
  votes: [vote2],
};

const inputCommitment2 = computeInputCommitment(input2);

console.log('Input:');
console.log('  electionId:', electionId2);
console.log('  bulletinRoot:', bulletinRoot2);
console.log('  treeSize:', treeSize2);
console.log('  totalExpected:', totalExpected2);
console.log('  votes[0].index:', vote2.index);
console.log('  votes[0].commitment:', vote2.commitment);
console.log('Output:');
console.log('  inputCommitment:', inputCommitment2);
console.log();

// Test Vector 3: Input Commitment with sorting
console.log('=== Test Vector 3: Input Commitment with sorting ===');
const electionId3 = '123e4567-e89b-12d3-a456-426614174000';

const vote3a: VoteWithProof = {
  commitment: computeCommitment(electionId3, 1, '0x' + '01'.repeat(32)),
  choice: 1,
  random: '0x' + '01'.repeat(32),
  index: 5,
  merklePath: [],
};

const vote3b: VoteWithProof = {
  commitment: computeCommitment(electionId3, 2, '0x' + '02'.repeat(32)),
  choice: 2,
  random: '0x' + '02'.repeat(32),
  index: 2,
  merklePath: [],
};

const vote3c: VoteWithProof = {
  commitment: computeCommitment(electionId3, 0, '0x' + '03'.repeat(32)),
  choice: 0,
  random: '0x' + '03'.repeat(32),
  index: 8,
  merklePath: [],
};

const input3: ZkVMInput = {
  electionId: electionId3,
  bulletinRoot: '0x' + '44'.repeat(32),
  treeSize: 10,
  logId: '0x' + '55'.repeat(32),
  timestamp: 1234567890,
  totalExpected: 10,
  electionConfigHash: '0x' + '66'.repeat(32),
  votes: [vote3a, vote3b, vote3c], // Unsorted order: 5, 2, 8
};

const inputCommitment3 = computeInputCommitment(input3);

console.log('Input:');
console.log('  electionId:', electionId3);
console.log('  votes (unsorted): indices [5, 2, 8]');
console.log('  votes (sorted): indices [2, 5, 8]');
console.log('Output:');
console.log('  inputCommitment:', inputCommitment3);
console.log();

// Test Vector 3b: duplicate-index tie-break ordering
console.log('=== Test Vector 3b: Input Commitment duplicate-index tie-break ===');
const input3b: ZkVMInput = {
  electionId: electionId2,
  bulletinRoot: '0x' + '11'.repeat(32),
  treeSize: 8,
  logId: '0x' + '77'.repeat(32),
  timestamp: 1234567890,
  totalExpected: 3,
  electionConfigHash: '0x' + '88'.repeat(32),
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

console.log('Input:');
console.log('  electionId:', input3b.electionId);
console.log('  votes (input order): [(3, 0x22.., 0x44..), (3, 0x11.., 0x55..), (3, 0x11.., 0x33..)]');
console.log('  canonical order:    [(3, 0x11.., 0x33..), (3, 0x11.., 0x55..), (3, 0x22.., 0x44..)]');
console.log('Output:');
console.log('  inputCommitment:', computeInputCommitment(input3b));
console.log();

// Test Vector 4: Included Bitmap Root (8 bits)
console.log('=== Test Vector 4: Included Bitmap Root (8 bits) ===');
const bitmap4: boolean[] = [
  true, // index 0
  false, // index 1
  true, // index 2
  true, // index 3
  false, // index 4
  false, // index 5
  true, // index 6
  false, // index 7
];

// Pack bits into bytes (LSB first)
const byte4 = 0b01001101; // = 0x4D

// Use CT-style leaf hashing to match Rust
const padded4 = Buffer.alloc(32);
padded4[0] = byte4;
const leafHash4 = createHash('sha256');
leafHash4.update(Buffer.from([0x00])); // CT-style leaf prefix
leafHash4.update(Buffer.from('stark-ballot:leaf|v1')); // Domain tag
leafHash4.update(padded4); // 32-byte padded data
const bitmapRoot4 = leafHash4.digest('hex');

console.log('Input:');
console.log('  bitmap:', bitmap4.map((b) => (b ? '1' : '0')).join(''));
console.log('  packed byte (LSB first): 0x' + byte4.toString(16).padStart(2, '0').toUpperCase());
console.log('Output:');
console.log('  bitmapRoot (CT-style hash):', '0x' + bitmapRoot4);
console.log();

// Test Vector 5: Included Bitmap Root (12 bits)
console.log('=== Test Vector 5: Included Bitmap Root (12 bits) ===');
const bitmap5 = Array.from({ length: 12 }, () => false);
bitmap5[0] = true; // bit 0
bitmap5[3] = true; // bit 3
bitmap5[11] = true; // bit 11

// Pack bits into bytes (LSB first)
// Byte 0: bits 0-7 = 0b00001001 = 0x09
// Byte 1: bits 8-11 = 0b00001000 = 0x08
const bytes5 = Buffer.from([0x09, 0x08]);

// Use CT-style leaf hashing to match Rust
const padded5 = Buffer.alloc(32);
padded5.set(bytes5, 0);
const leafHash5 = createHash('sha256');
leafHash5.update(Buffer.from([0x00])); // CT-style leaf prefix
leafHash5.update(Buffer.from('stark-ballot:leaf|v1')); // Domain tag
leafHash5.update(padded5); // 32-byte padded data
const bitmapRoot5 = leafHash5.digest('hex');

console.log('Input:');
console.log('  bitmap:', bitmap5.map((b) => (b ? '1' : '0')).join(''));
console.log('  packed bytes (LSB first): 0x' + bytes5.toString('hex').toUpperCase());
console.log('Output:');
console.log('  bitmapRoot (CT-style hash):', '0x' + bitmapRoot5);
console.log();

// Test Vector 6: Complete scenario with MockZkVM
console.log('=== Test Vector 6: Complete MockZkVM Execution ===');
import { executeMockZkVM } from '../src/lib/zkvm/mock-executor';

const electionId6 = 'abcdef12-3456-7890-abcd-ef1234567890';
const input6: ZkVMInput = {
  electionId: electionId6,
  bulletinRoot: '0x' + '77'.repeat(32),
  treeSize: 5,
  logId: '0x' + '88'.repeat(32),
  timestamp: 1000000000,
  totalExpected: 5,
  electionConfigHash: '0x' + '99'.repeat(32),
  votes: [
    {
      commitment: computeCommitment(electionId6, 0, '0x' + 'a1'.repeat(32)),
      choice: 0,
      random: '0x' + 'a1'.repeat(32),
      index: 0,
      merklePath: [],
    },
    {
      commitment: computeCommitment(electionId6, 1, '0x' + 'b2'.repeat(32)),
      choice: 1,
      random: '0x' + 'b2'.repeat(32),
      index: 2,
      merklePath: [],
    },
    {
      commitment: computeCommitment(electionId6, 2, '0x' + 'c3'.repeat(32)),
      choice: 2,
      random: '0x' + 'c3'.repeat(32),
      index: 4,
      merklePath: [],
    },
  ],
};

executeMockZkVM(input6)
  .then((result) => {
    console.log('Input:');
    console.log('  electionId:', electionId6);
    console.log('  treeSize:', input6.treeSize);
    console.log('  votes.length:', input6.votes.length);
    console.log('Output (ZkVMJournal):');
    console.log('  sthDigest:', result.sthDigest);
    console.log('  inputCommitment:', result.inputCommitment);
    console.log('  includedBitmapRoot:', result.includedBitmapRoot);
    console.log('  verifiedTally:', result.verifiedTally);
    console.log('  missingSlots:', result.missingSlots);
    console.log('  invalidPresentedSlots:', result.invalidPresentedSlots);
    console.log('  validVotes:', result.validVotes);
    console.log('  Three-way split sum:', result.missingSlots + result.invalidPresentedSlots + result.validVotes);
    console.log('  Expected (treeSize):', input6.treeSize);
    console.log();
    console.log('===== End of Test Vectors =====');
  })
  .catch((error) => {
    console.error('[generate-test-vectors] Failed to execute mock zkVM:', error);
    process.exitCode = 1;
  });
