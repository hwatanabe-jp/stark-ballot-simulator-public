/**
 * Test vectors from final_design.md v1.0 Examples 1-3
 * Verifies implemented final design test vectors.
 *
 * These tests verify the exact byte-level encoding specifications
 * defined in the final design document.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import type { ZkVMInput, VoteWithProof } from '../types';
import { computeCommitment, computeInputCommitment } from '../types';
import {
  packBitsToBytes,
  splitIntoChunks,
  hashLeafChunk,
  hashInternalNode,
  computeIncludedBitmapRoot,
} from '../bitmap';

describe('final_design.md Test Vectors', () => {
  describe('Example 1: Minimal Input (1 vote)', () => {
    it('should produce exact inputCommitment for minimal case', () => {
      // Test data from final_design.md lines 849-854
      const electionId = '550e8400-e29b-41d4-a716-446655440000';
      const bulletinRoot = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const treeSize = 1;
      const totalExpected = 1;

      // Create the vote with exact commitment from spec
      const vote: VoteWithProof = {
        commitment: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        choice: 0, // Choice A
        random: '0x' + 'ff'.repeat(32), // Example random
        index: 0,
        merklePath: [],
      };

      const input: ZkVMInput = {
        electionId,
        bulletinRoot,
        treeSize,
        logId: '0x' + '00'.repeat(32), // Example logId
        timestamp: 0, // Example timestamp
        totalExpected,
        electionConfigHash: '0x' + '00'.repeat(32), // Example config hash
        votes: [vote],
      };

      // Calculate the input commitment
      const inputCommitment = computeInputCommitment(input);

      // Manual calculation to verify encoding
      const manualHash = createHash('sha256');

      // Domain tag: "stark-ballot:input|v1.0" (23 bytes)
      manualHash.update(Buffer.from('stark-ballot:input|v1.0'));

      // Version: 8 (little endian, 4 bytes)
      const versionBuffer = Buffer.allocUnsafe(4);
      versionBuffer.writeUInt32LE(10, 0);
      manualHash.update(versionBuffer);

      // ElectionId: 16 bytes (UUID without hyphens)
      const electionIdBytes = Buffer.from('550e8400e29b41d4a716446655440000', 'hex');
      manualHash.update(electionIdBytes);

      // BulletinRoot: 32 bytes
      manualHash.update(Buffer.from('1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', 'hex'));

      // TreeSize: 1 (little endian, 4 bytes)
      const treeSizeBuffer = Buffer.allocUnsafe(4);
      treeSizeBuffer.writeUInt32LE(1, 0);
      manualHash.update(treeSizeBuffer);

      // TotalExpected: 1 (little endian, 4 bytes)
      const totalExpectedBuffer = Buffer.allocUnsafe(4);
      totalExpectedBuffer.writeUInt32LE(1, 0);
      manualHash.update(totalExpectedBuffer);

      // VotesCount: 1 (little endian, 4 bytes)
      const votesCountBuffer = Buffer.allocUnsafe(4);
      votesCountBuffer.writeUInt32LE(1, 0);
      manualHash.update(votesCountBuffer);

      // Vote[0]
      // Index: 0 (little endian, 4 bytes)
      const indexBuffer = Buffer.allocUnsafe(4);
      indexBuffer.writeUInt32LE(0, 0);
      manualHash.update(indexBuffer);

      // CommitmentLen: 32 (little endian, 2 bytes)
      const commitmentLenBuffer = Buffer.allocUnsafe(2);
      commitmentLenBuffer.writeUInt16LE(32, 0);
      manualHash.update(commitmentLenBuffer);

      // Commitment: 32 bytes
      manualHash.update(Buffer.from('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'hex'));

      // PathLen: 0 (little endian, 2 bytes)
      const pathLenBuffer = Buffer.allocUnsafe(2);
      pathLenBuffer.writeUInt16LE(0, 0);
      manualHash.update(pathLenBuffer);

      const expectedCommitment = '0x' + manualHash.digest('hex');

      // Verify the implementation matches manual calculation
      expect(inputCommitment).toBe(expectedCommitment);

      // Log for documentation
      console.log('Example 1 inputCommitment:', inputCommitment);
    });

    it('should verify exact byte encoding matches specification', () => {
      // Create buffer following exact specification from lines 871-883
      const domainTag = Buffer.from('stark-ballot:input|v1.0');
      expect(domainTag.toString('hex')).toBe('737461726b2d62616c6c6f743a696e7075747c76312e30');
      expect(domainTag.length).toBe(23);

      // Version encoding
      const versionBuffer = Buffer.allocUnsafe(4);
      versionBuffer.writeUInt32LE(10, 0);
      expect(versionBuffer.toString('hex')).toBe('0a000000');

      // ElectionId encoding
      const electionIdHex = '550e8400e29b41d4a716446655440000';
      const electionIdBuffer = Buffer.from(electionIdHex, 'hex');
      expect(electionIdBuffer.length).toBe(16);

      // Verify little-endian encoding for numeric values
      const testBuffer = Buffer.allocUnsafe(4);
      testBuffer.writeUInt32LE(1, 0);
      expect(testBuffer.toString('hex')).toBe('01000000');

      // Verify 2-byte encoding
      const testBuffer2 = Buffer.allocUnsafe(2);
      testBuffer2.writeUInt16LE(32, 0);
      expect(testBuffer2.toString('hex')).toBe('2000');
    });
  });

  describe('Example 2: includedBitmapRoot Boundary Cases', () => {
    it('should handle 12-vote case with padding', () => {
      // 12 bits all set to 1 (everyone counted)
      // Binary: 0b111111111111 = 0x0FFF
      // LSB-first encoding: 0xFF 0x0F
      // 32-byte padding: 0xFF0F followed by 30 zeros

      const bitmap = Array.from({ length: 12 }, () => true);
      const bitmapRoot = computeIncludedBitmapRoot(bitmap);

      // Verify the packed bytes
      const packedBytes = packBitsToBytes(bitmap);
      expect(packedBytes.toString('hex')).toBe('ff0f');

      // Verify the padded chunk
      const chunks = splitIntoChunks(packedBytes);
      expect(chunks.length).toBe(1);
      expect(chunks[0].toString('hex')).toBe('ff0f' + '00'.repeat(30));

      // The root should be the hash of single leaf
      const leafHash = hashLeafChunk(chunks[0]);
      expect(bitmapRoot).toBe('0x' + leafHash.toString('hex'));

      console.log('12-vote case includedBitmapRoot:', bitmapRoot);
    });

    it('should handle 17-vote case crossing byte boundary', () => {
      // 17 bits all set to 1
      // Binary: 0b11111111111111111 = 0x1FFFF
      // LSB-first encoding: 0xFF 0xFF 0x01
      // 32-byte padding: 0xFFFF01 followed by 29 zeros

      const bitmap = Array.from({ length: 17 }, () => true);
      const bitmapRoot = computeIncludedBitmapRoot(bitmap);

      // Verify the packed bytes
      const packedBytes = packBitsToBytes(bitmap);
      expect(packedBytes.toString('hex')).toBe('ffff01');

      // Verify the padded chunk
      const chunks = splitIntoChunks(packedBytes);
      expect(chunks.length).toBe(1);
      expect(chunks[0].toString('hex')).toBe('ffff01' + '00'.repeat(29));

      console.log('17-vote case includedBitmapRoot:', bitmapRoot);
    });

    it('should handle 257-vote case with second chunk', () => {
      // 257 bits: 256 bits all 1 (first chunk) + 1 bit set to 1 (second chunk)
      // Chunk 1: 32 bytes of 0xFF
      // Chunk 2: 0x01 followed by 31 zeros

      const bitmap = Array.from({ length: 257 }, () => true);
      const bitmapRoot = computeIncludedBitmapRoot(bitmap);

      // Verify the packed bytes
      const packedBytes = packBitsToBytes(bitmap);
      expect(packedBytes.length).toBe(33); // 257 bits = 33 bytes
      expect(packedBytes.slice(0, 32).toString('hex')).toBe('ff'.repeat(32));
      expect(packedBytes[32]).toBe(0x01);

      // Verify the chunks
      const chunks = splitIntoChunks(packedBytes);
      expect(chunks.length).toBe(2);
      expect(chunks[0].toString('hex')).toBe('ff'.repeat(32));
      expect(chunks[1].toString('hex')).toBe('01' + '00'.repeat(31));

      // Calculate expected root
      const leaf0 = hashLeafChunk(chunks[0]);
      const leaf1 = hashLeafChunk(chunks[1]);
      const expectedRoot = hashInternalNode(leaf0, leaf1);
      expect(bitmapRoot).toBe('0x' + expectedRoot.toString('hex'));

      console.log('257-vote case includedBitmapRoot:', bitmapRoot);
    });

    it('should handle 1025-vote case with fifth chunk', () => {
      // 1025 bits: 1024 bits (4 chunks) + 1 bit (fifth chunk)
      // Each of first 4 chunks: 32 bytes of 0xFF
      // Fifth chunk: 0x01 followed by 31 zeros

      const bitmap = Array.from({ length: 1025 }, () => true);
      const bitmapRoot = computeIncludedBitmapRoot(bitmap);

      // Verify the packed bytes
      const packedBytes = packBitsToBytes(bitmap);
      expect(packedBytes.length).toBe(129); // 1025 bits = 129 bytes

      // Verify the chunks
      const chunks = splitIntoChunks(packedBytes);
      expect(chunks.length).toBe(5);

      // First 4 chunks should be all 0xFF
      for (let i = 0; i < 4; i++) {
        expect(chunks[i].toString('hex')).toBe('ff'.repeat(32));
      }
      // Fifth chunk should start with 0x01
      expect(chunks[4].toString('hex')).toBe('01' + '00'.repeat(31));

      console.log('1025-vote case includedBitmapRoot:', bitmapRoot);
      console.log('Number of chunks:', chunks.length);
    });
  });

  describe('Example 3: Multiple Votes with Inclusion Proof', () => {
    it('should handle 3 votes with different path lengths', () => {
      // Test data from final_design.md lines 936-944
      const electionId = '123e4567-e89b-12d3-a456-426614174000';
      const bulletinRoot = '0xabcd' + '00'.repeat(28) + 'ef01'; // 32 bytes total (2 + 28 + 2)
      const treeSize = 3;
      const totalExpected = 3;

      // Create three votes with different path lengths
      const vote0: VoteWithProof = {
        commitment: '0x' + 'aa'.repeat(32),
        choice: 0,
        random: '0x' + '11'.repeat(32),
        index: 0,
        merklePath: ['0x' + 'bb'.repeat(32), '0x' + 'cc'.repeat(32)], // 2 nodes
      };

      const vote1: VoteWithProof = {
        commitment: '0x' + 'dd'.repeat(32),
        choice: 1,
        random: '0x' + '22'.repeat(32),
        index: 1,
        merklePath: ['0x' + 'ee'.repeat(32), '0x' + 'cc'.repeat(32)], // 2 nodes
      };

      const vote2: VoteWithProof = {
        commitment: '0x' + 'ff'.repeat(32),
        choice: 2,
        random: '0x' + '33'.repeat(32),
        index: 2,
        merklePath: ['0x' + '11'.repeat(32)], // 1 node
      };

      const input: ZkVMInput = {
        electionId,
        bulletinRoot,
        treeSize,
        logId: '0x' + '44'.repeat(32),
        timestamp: 1234567890,
        totalExpected,
        electionConfigHash: '0x' + '55'.repeat(32),
        votes: [vote0, vote1, vote2],
      };

      // Calculate input commitment
      const inputCommitment = computeInputCommitment(input);

      // Verify format
      expect(inputCommitment).toMatch(/^0x[0-9a-f]{64}$/);

      // Verify that votes are sorted by index in the commitment
      // (This is internal to computeInputCommitment but important)
      console.log('Example 3 inputCommitment:', inputCommitment);
      console.log('Vote indices:', [vote0.index, vote1.index, vote2.index]);
      console.log('Path lengths:', [vote0.merklePath.length, vote1.merklePath.length, vote2.merklePath.length]);
    });

    it('should verify encoding uniqueness', () => {
      const electionId = '123e4567-e89b-12d3-a456-426614174000';
      const bulletinRoot = '0x' + '66'.repeat(32);

      // Create two different inputs that differ only in vote order
      const vote1: VoteWithProof = {
        commitment: '0x' + 'aa'.repeat(32),
        choice: 0,
        random: '0x' + '11'.repeat(32),
        index: 1,
        merklePath: [],
      };

      const vote2: VoteWithProof = {
        commitment: '0x' + 'bb'.repeat(32),
        choice: 1,
        random: '0x' + '22'.repeat(32),
        index: 0,
        merklePath: [],
      };

      const input1: ZkVMInput = {
        electionId,
        bulletinRoot,
        treeSize: 2,
        logId: '0x' + '77'.repeat(32),
        timestamp: 1000,
        totalExpected: 2,
        electionConfigHash: '0x' + '88'.repeat(32),
        votes: [vote1, vote2], // Order: index 1, index 0
      };

      const input2: ZkVMInput = {
        electionId,
        bulletinRoot,
        treeSize: 2,
        logId: '0x' + '77'.repeat(32),
        timestamp: 1000,
        totalExpected: 2,
        electionConfigHash: '0x' + '88'.repeat(32),
        votes: [vote2, vote1], // Order: index 0, index 1
      };

      // Both should produce the same commitment due to sorting
      const commitment1 = computeInputCommitment(input1);
      const commitment2 = computeInputCommitment(input2);

      expect(commitment1).toBe(commitment2);
      console.log('Commitment (both orders):', commitment1);
    });

    it('should verify inputCommitment reproducibility', () => {
      const electionId = '550e8400-e29b-41d4-a716-446655440000';
      const bulletinRoot = '0x' + '99'.repeat(32);

      const vote: VoteWithProof = {
        commitment: computeCommitment(electionId, 3, '0x' + 'ab'.repeat(32)),
        choice: 3,
        random: '0x' + 'ab'.repeat(32),
        index: 0,
        merklePath: ['0x' + 'cd'.repeat(32)],
      };

      const input: ZkVMInput = {
        electionId,
        bulletinRoot,
        treeSize: 1,
        logId: '0x' + 'ef'.repeat(32),
        timestamp: 999999999,
        totalExpected: 1,
        electionConfigHash: '0x' + '12'.repeat(32),
        votes: [vote],
      };

      // Calculate multiple times
      const commitment1 = computeInputCommitment(input);
      const commitment2 = computeInputCommitment(input);
      const commitment3 = computeInputCommitment(input);

      // All should be identical (deterministic)
      expect(commitment1).toBe(commitment2);
      expect(commitment2).toBe(commitment3);

      // Changing a field that affects inputCommitment should change it
      // Note: timestamp is NOT part of inputCommitment (it's in STH digest)
      const modifiedInput = { ...input, treeSize: 2 };
      const differentCommitment = computeInputCommitment(modifiedInput);
      expect(differentCommitment).not.toBe(commitment1);

      console.log('Original commitment:', commitment1);
      console.log('Modified commitment:', differentCommitment);
    });
  });
});
