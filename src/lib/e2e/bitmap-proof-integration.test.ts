/**
 * Integration test for bitmap proof API
 * Tests the complete flow from finalization to proof verification
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { MockSessionStore } from '@/lib/store/mockSessionStore';
import { executeMockZkVM, getLastExecutedBitmap } from '@/lib/zkvm/mock-executor';
import { generateBitmapMerkleProof, verifyBitmapMerkleProof } from '@/lib/merkle/bitmap-merkle-tree';
import { computeIncludedBitmapRoot } from '@/lib/zkvm/bitmap';
import { resolveCurrentContractGeneration } from '@/lib/contract';
import { createTestJournal } from '@/lib/testing/test-helpers';
import type { ZkVMInput } from '@/lib/zkvm/types';
import { computeCommitment } from '@/lib/zkvm/types';

describe('Bitmap Proof Integration Test', () => {
  let store: MockSessionStore;

  beforeEach(() => {
    store = new MockSessionStore();
  });

  const finalizeSessionForBitmap = async (sessionId: string, totalExpected: number): Promise<void> => {
    const journal = createTestJournal({
      totalExpected,
      validVotes: totalExpected,
      missingIndices: 0,
      invalidIndices: 0,
    });

    await store.finalizeSession(
      sessionId,
      {
        tally: {
          counts: { A: 13, B: 13, C: 13, D: 13, E: 12 },
          totalVotes: totalExpected,
          tamperedCount: 0,
        },
        imageId: journal.imageId ?? '0x' + '1'.repeat(64),
        journal,
        verificationExecutionId: 'exec-bitmap-test',
      },
      resolveCurrentContractGeneration(),
    );
  };

  it('should complete full flow: finalize → save bitmap → generate proof → verify', async () => {
    const session = await store.createSession();

    // Step 1: Create test input for zkVM
    const testInput: ZkVMInput = {
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 64,
      logId: '0x' + 'b'.repeat(64),
      timestamp: Date.now(),
      totalExpected: 64,
      electionConfigHash: '0x' + 'c'.repeat(64),
      votes: [],
    };

    // Create test votes
    for (let i = 0; i < 64; i++) {
      const choice = i % 5; // Distribute across A-E
      const random = '0x' + 'f'.repeat(64);
      const commitment = computeCommitment(testInput.electionId, choice, random);

      testInput.votes.push({
        commitment,
        choice,
        random,
        index: i,
        merklePath: [], // Simplified for testing
      });
    }

    // Step 2: Execute mock zkVM
    const zkVMResult = await executeMockZkVM(testInput);

    expect(zkVMResult).toBeDefined();
    expect(zkVMResult.includedBitmapRoot).toBeDefined();
    expect(zkVMResult.treeSize).toBe(64);

    // Step 3: Get the bitmap from MockZkVM
    const includedBitmap = getLastExecutedBitmap();
    expect(includedBitmap).toBeDefined();
    expect(includedBitmap).toHaveLength(64);

    await finalizeSessionForBitmap(session.sessionId, testInput.totalExpected);

    // Step 4: Save bitmap data to store
    if (includedBitmap) {
      await store.saveBitmapData(session.sessionId, {
        includedBitmap,
        includedBitmapRoot: zkVMResult.includedBitmapRoot,
        treeSize: zkVMResult.treeSize,
        finalizedAt: Date.now(),
      });
    }

    // Step 5: Retrieve bitmap data
    const storedBitmap = await store.getBitmapData(session.sessionId);
    expect(storedBitmap).toBeDefined();
    expect(storedBitmap?.includedBitmapRoot).toBe(zkVMResult.includedBitmapRoot);

    // Step 6: Generate proof for a specific index
    const testIndex = 42;
    if (!storedBitmap) {
      throw new Error('Expected stored bitmap data');
    }
    const proof = generateBitmapMerkleProof(storedBitmap.includedBitmap, testIndex);

    expect(proof).toBeDefined();
    expect(proof.leafChunk).toHaveLength(64); // 32 bytes in hex
    expect(proof.bitIndex).toBe(testIndex);

    // Step 7: Verify the proof
    const verificationResult = verifyBitmapMerkleProof(
      proof.leafChunk,
      proof.auditPath,
      zkVMResult.includedBitmapRoot,
      testIndex,
    );

    expect(verificationResult.valid).toBe(true);
    expect(verificationResult.leafIndex).toBe(0); // Index 42 is in first leaf
    expect(verificationResult.bitOffset).toBe(42);
  });

  it('should correctly identify excluded votes', async () => {
    // Create input with some excluded votes
    const testInput: ZkVMInput = {
      electionId: '550e8400-e29b-41d4-a716-446655440001',
      bulletinRoot: '0x' + '1'.repeat(64),
      treeSize: 10,
      logId: '0x' + '2'.repeat(64),
      timestamp: Date.now(),
      totalExpected: 10,
      electionConfigHash: '0x' + '3'.repeat(64),
      votes: [],
    };

    // Add only 7 votes (simulating 3 excluded)
    for (let i = 0; i < 7; i++) {
      const choice = i % 5;
      // Use unique random for each vote to avoid duplicates
      const random = '0x' + i.toString(16).padStart(64, '5');
      const commitment = computeCommitment(testInput.electionId, choice, random);

      testInput.votes.push({
        commitment,
        choice,
        random,
        index: i,
        merklePath: [],
      });
    }

    // Execute zkVM
    const zkVMResult = await executeMockZkVM(testInput);
    const includedBitmap = getLastExecutedBitmap();

    expect(includedBitmap).toBeDefined();
    if (includedBitmap) {
      // Check that votes 0-6 are included
      for (let i = 0; i < 7; i++) {
        expect(includedBitmap[i]).toBe(true);
      }

      // Check that indices 7-9 are excluded (not presented to VM)
      for (let i = 7; i < 10; i++) {
        expect(includedBitmap[i]).toBe(false);
      }

      // Verify excluded count matches
      expect(zkVMResult.missingSlots).toBe(3); // 10 - 7 = 3 missing
    }
  });

  it('should handle tampered votes correctly', async () => {
    const testInput: ZkVMInput = {
      electionId: '550e8400-e29b-41d4-a716-446655440002',
      bulletinRoot: '0x' + '6'.repeat(64),
      treeSize: 5,
      logId: '0x' + '7'.repeat(64),
      timestamp: Date.now(),
      totalExpected: 5,
      electionConfigHash: '0x' + '8'.repeat(64),
      votes: [],
    };

    // Add votes with invalid commitments (intentionally wrong)
    for (let i = 0; i < 5; i++) {
      // Create intentionally wrong commitment (doesn't match choice/random)
      const wrongCommitment = '0x' + '9'.repeat(64);

      testInput.votes.push({
        commitment: wrongCommitment, // This will fail validation
        choice: i % 5,
        random: '0x' + 'a'.repeat(64),
        index: i,
        merklePath: [],
      });
    }

    // Execute zkVM
    const zkVMResult = await executeMockZkVM(testInput);
    const includedBitmap = getLastExecutedBitmap();

    expect(includedBitmap).toBeDefined();
    if (includedBitmap) {
      // All votes should be marked as excluded due to invalid commitments
      for (let i = 0; i < 5; i++) {
        expect(includedBitmap[i]).toBe(false);
      }

      // All votes should be invalid
      expect(zkVMResult.invalidVotes).toBe(5);
      expect(zkVMResult.validVotes).toBe(0);
    }
  });

  it('should generate consistent bitmap root', () => {
    // Create a known bitmap
    const testBitmap = Array.from({ length: 256 }, () => false);
    testBitmap[0] = true;
    testBitmap[100] = true;
    testBitmap[255] = true;

    // Calculate root using the utility function
    const root1 = computeIncludedBitmapRoot(testBitmap);

    // Generate proof and verify to ensure consistency
    const proof = generateBitmapMerkleProof(testBitmap, 100);
    const verificationResult = verifyBitmapMerkleProof(proof.leafChunk, proof.auditPath, root1, 100);

    expect(verificationResult.valid).toBe(true);
    expect(verificationResult.included).toBe(true);

    // Verify unset bit
    const proof2 = generateBitmapMerkleProof(testBitmap, 50);
    const verificationResult2 = verifyBitmapMerkleProof(proof2.leafChunk, proof2.auditPath, root1, 50);

    expect(verificationResult2.valid).toBe(true);
    expect(verificationResult2.included).toBe(false);
  });
});
