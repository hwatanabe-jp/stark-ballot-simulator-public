/**
 * RFC 6962-inspired / CT-style Merkle Tree test suite.
 *
 * Tests for the CT-style Merkle Tree Hash (MTH) algorithm used by the
 * current bulletin path, including the app-specific leaf domain tag.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RFC6962MerkleTree } from './rfc6962-merkle-tree';
import { createHash } from 'crypto';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

const withBufferUnavailable = <T>(fn: () => T): T => {
  const globals = globalThis as Record<string, unknown>;
  const originalBuffer = globals['Buffer'];
  try {
    globals['Buffer'] = undefined;
    return fn();
  } finally {
    globals['Buffer'] = originalBuffer;
  }
};

// Create deterministic test leaves.
function createTestLeaf(index: number): string {
  return createHash('sha256').update(`leaf${index}`).digest('hex');
}

// Independently asserted by contract-core's reviewed_fixed_root_vectors test.
// Keep these as fixed review data; do not derive expected roots from this tree.
const REVIEWED_FIXED_LEAVES = [
  '4d5a9584d985e8fb44015a8affa9b76f1ff16f65e61df7156d8e8159e1448978',
  'd103cfb5e499c566904787533afbdec56f95492d67fc00e2c0d0161ba99653f1',
  '5038da95330ba16edb486954197e37eb777c3047327ca54df4199c35c5edc17a',
  'f2764fd79fdab5132fc349ba555c9c56ff0c935c889c17ebe3d61315d780934e',
  '565fb0e0cefe32cf4000e4a67ddec8820111a733aa8ba010d242a5fe477e04c4',
] as const;

const REVIEWED_FIXED_ROOT_VECTORS = [
  {
    label: 'empty tree',
    leafCount: 0,
    expectedRoot: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  {
    label: 'one-leaf tree',
    leafCount: 1,
    expectedRoot: 'b089dd645b2222877852a1873580e50a66fb463fee184dbc734224c4ee1e5d06',
  },
  {
    label: 'two-leaf tree',
    leafCount: 2,
    expectedRoot: '33e32ea1ae0ad2fb4349df42021702b680127fff927526fb41ff3770d7f8dd41',
  },
  {
    label: 'four-leaf tree',
    leafCount: 4,
    expectedRoot: '77eacf9bc18b97c9e11f7131cda0593c707f7d73c77afad01ee83eb708e9105c',
  },
  {
    label: 'five-leaf odd tree',
    leafCount: 5,
    expectedRoot: '2a278fbb796b135a154966d522a0cd90424cc4cd014c8acc6d9b8a7293a4d365',
  },
] as const;

const REVIEWED_ONE_LEAF_ROOT = REVIEWED_FIXED_ROOT_VECTORS[1].expectedRoot;

describe('RFC6962MerkleTree', () => {
  let tree: RFC6962MerkleTree;

  beforeEach(() => {
    tree = new RFC6962MerkleTree();
  });

  describe('MTH function tests', () => {
    it.each(REVIEWED_FIXED_ROOT_VECTORS)('matches the Rust-reviewed root for a $label', (vector) => {
      const leaves = REVIEWED_FIXED_LEAVES.slice(0, vector.leafCount);
      leaves.forEach((leaf) => tree.append(leaf));

      expect(tree.size).toBe(vector.leafCount);
      expect(tree.getRoot()).toBe(vector.expectedRoot);
    });

    it('should compute roots without Node Buffer', () => {
      const leaf = strictDefined(REVIEWED_FIXED_LEAVES[0]);

      const root = withBufferUnavailable(() => {
        const localTree = new RFC6962MerkleTree();
        localTree.append(leaf);
        return localTree.getRoot();
      });

      expect(root).toBe(REVIEWED_ONE_LEAF_ROOT);
    });
  });

  describe('append operation tests', () => {
    it('should grow tree incrementally', () => {
      const roots = [];

      for (let i = 0; i < 10; i++) {
        const leaf = createTestLeaf(i);
        tree.append(leaf);
        roots.push(tree.getRoot());
        expect(tree.size).toBe(i + 1);
      }

      // Each root should be different (no duplicates)
      const uniqueRoots = new Set(roots);
      expect(uniqueRoots.size).toBe(10);
    });

    it('should maintain append-only property', () => {
      const leaves = [];
      const rootHistory = [];

      for (let i = 0; i < 8; i++) {
        const leaf = createTestLeaf(i);
        leaves.push(leaf);
        tree.append(leaf);
        rootHistory.push({
          size: tree.size,
          root: tree.getRoot(),
        });
      }

      // Historical roots should be retrievable
      for (let i = 0; i < rootHistory.length; i++) {
        const historicalRoot = tree.getRootAtSize(i + 1);
        expect(historicalRoot).toBe(strictDefined(rootHistory[i]).root);
      }
    });

    it('should handle large trees efficiently', () => {
      const leaves = [];
      for (let i = 0; i < 1000; i++) {
        const leaf = createTestLeaf(i);
        leaves.push(leaf);
        tree.append(leaf);
      }

      expect(tree.size).toBe(1000);
      const root = tree.getRoot();
      expect(root).toBeDefined();
      expect(root.length).toBe(64); // SHA256 hex string
    });

    it('should reject invalid append operations', () => {
      expect(() => tree.append('')).toThrow('Leaf cannot be empty');
      expect(() => tree.append('invalid')).toThrow('Invalid hex string');
      expect(() => tree.append('zz'.repeat(32))).toThrow('Invalid hex string');
      expect(() => tree.append('a'.repeat(63))).toThrow('Invalid hex string');
      expect(() => tree.append('a'.repeat(62))).toThrow('Invalid hex string');
      expect(() => tree.append('b'.repeat(66))).toThrow('Invalid hex string');
    });
  });

  describe('getRootAtSize efficiency tests', () => {
    it('should cache computed roots', () => {
      // Add 100 leaves
      for (let i = 0; i < 100; i++) {
        tree.append(createTestLeaf(i));
      }

      // Assert cache behavior directly; wall-clock ratios vary with scheduler load.
      tree.clearCache();
      const root50_1 = tree.getRootAtSize(50);
      const cacheSize = tree.getCacheSize();
      expect(tree.getCacheHitRate()).toBe(0);

      const root50_2 = tree.getRootAtSize(50);

      expect(root50_1).toBe(root50_2);
      expect(cacheSize).toBeGreaterThan(0);
      expect(tree.getCacheSize()).toBe(cacheSize);
      expect(tree.getCacheHitRate()).toBe(0.5);
    });

    it('should throw error for invalid sizes', () => {
      tree.append(createTestLeaf(0));
      tree.append(createTestLeaf(1));

      expect(() => tree.getRootAtSize(0)).toThrow('Size must be positive');
      expect(() => tree.getRootAtSize(-1)).toThrow('Size must be positive');
      expect(() => tree.getRootAtSize(3)).toThrow('Size 3 exceeds tree size 2');
    });
  });

  describe('consistency proof generation', () => {
    it('should generate empty proof for same size', () => {
      // Add some leaves
      for (let i = 0; i < 5; i++) {
        tree.append(createTestLeaf(i));
      }

      const proof = tree.getConsistencyProof(5, 5);
      expect(proof.oldSize).toBe(5);
      expect(proof.newSize).toBe(5);
      expect(proof.proofNodes).toEqual([]);
    });

    it('should generate proof for consecutive sizes (1→2)', () => {
      tree.append(createTestLeaf(0));
      tree.append(createTestLeaf(1));

      const proof = tree.getConsistencyProof(1, 2);
      expect(proof.oldSize).toBe(1);
      expect(proof.newSize).toBe(2);
      expect(proof.proofNodes.length).toBe(1);

      // For 1→2, the proof should contain the second leaf (raw, not MTH)
      expect(strictDefined(proof.proofNodes[0])).toBe(createTestLeaf(1));
    });

    it('should return raw leaf for 1→2 consistency proof (not MTH)', () => {
      const leaf0 = createTestLeaf(0);
      const leaf1 = createTestLeaf(1);
      tree.append(leaf0);
      tree.append(leaf1);

      const proof = tree.getConsistencyProof(1, 2);

      // The proof must contain the raw leaf1, not MTH(leaf1)
      expect(proof.proofNodes.length).toBe(1);
      expect(strictDefined(proof.proofNodes[0])).toBe(leaf1);

      // MTH(leaf1) would be different (includes domain separator)
      const mthLeaf1 = createHash('sha256')
        .update(Buffer.from([0x00]))
        .update(Buffer.from(leaf1, 'hex'))
        .digest('hex');
      expect(strictDefined(proof.proofNodes[0])).not.toBe(mthLeaf1);
    });

    it('should generate proof for power-of-2 case (4→8)', () => {
      for (let i = 0; i < 8; i++) {
        tree.append(createTestLeaf(i));
      }

      const proof = tree.getConsistencyProof(4, 8);
      expect(proof.oldSize).toBe(4);
      expect(proof.newSize).toBe(8);
      expect(proof.proofNodes.length).toBeGreaterThan(0);

      // For 4→8, we need the hash of leaves[4:8]
      // The proof should allow verifying both old and new roots
    });

    it('should handle non-power-of-2 cases (3→7)', () => {
      for (let i = 0; i < 7; i++) {
        tree.append(createTestLeaf(i));
      }

      const proof = tree.getConsistencyProof(3, 7);
      expect(proof.oldSize).toBe(3);
      expect(proof.newSize).toBe(7);
      expect(proof.proofNodes.length).toBeGreaterThan(0);

      // Verify the proof actually works
      const root3 = tree.getRootAtSize(3);
      const root7 = tree.getRootAtSize(7);
      expect(tree.verifyConsistencyProof(root3, root7, proof)).toBe(true);
    });

    it('should handle complex cases (5→13)', () => {
      for (let i = 0; i < 13; i++) {
        tree.append(createTestLeaf(i));
      }

      const proof = tree.getConsistencyProof(5, 13);
      expect(proof.oldSize).toBe(5);
      expect(proof.newSize).toBe(13);
      expect(proof.proofNodes.length).toBeGreaterThan(0);

      // Verify the proof works
      const root5 = tree.getRootAtSize(5);
      const root13 = tree.getRootAtSize(13);
      expect(tree.verifyConsistencyProof(root5, root13, proof)).toBe(true);
    });

    it('should generate correct proof for consecutive sizes (2→3)', () => {
      for (let i = 0; i < 3; i++) {
        tree.append(createTestLeaf(i));
      }

      const proof = tree.getConsistencyProof(2, 3);
      const root2 = tree.getRootAtSize(2);
      const root3 = tree.getRootAtSize(3);

      expect(proof.proofNodes.length).toBeGreaterThan(0);
      expect(tree.verifyConsistencyProof(root2, root3, proof)).toBe(true);
    });

    it('should throw error for invalid consistency proof parameters', () => {
      for (let i = 0; i < 5; i++) {
        tree.append(createTestLeaf(i));
      }

      expect(() => tree.getConsistencyProof(0, 5)).toThrow('oldSize must be positive');
      expect(() => tree.getConsistencyProof(5, 0)).toThrow('newSize must be positive');
      expect(() => tree.getConsistencyProof(6, 5)).toThrow('oldSize must be <= newSize');
      expect(() => tree.getConsistencyProof(5, 10)).toThrow('newSize 10 exceeds tree size 5');
    });
  });

  describe('consistency proof verification', () => {
    it('should verify correct consistency proof for same size', () => {
      for (let i = 0; i < 5; i++) {
        tree.append(createTestLeaf(i));
      }

      const root = tree.getRoot();
      const proof = tree.getConsistencyProof(5, 5);

      const isValid = tree.verifyConsistencyProof(root, root, proof);
      expect(isValid).toBe(true);
    });

    it('should verify correct consistency proof for different sizes', () => {
      // Add leaves and capture roots at different sizes
      const roots: string[] = [];
      for (let i = 0; i < 8; i++) {
        tree.append(createTestLeaf(i));
        roots.push(tree.getRoot());
      }

      // Verify consistency between size 4 and 8
      const proof = tree.getConsistencyProof(4, 8);
      const isValid = tree.verifyConsistencyProof(strictDefined(roots[3]), strictDefined(roots[7]), proof);
      expect(isValid).toBe(true);
    });

    it('should reject structurally invalid consistency proof', () => {
      for (let i = 0; i < 8; i++) {
        tree.append(createTestLeaf(i));
      }

      const root4 = tree.getRootAtSize(4);
      const root8 = tree.getRootAtSize(8);
      const proof = tree.getConsistencyProof(4, 8);

      // Use structurally invalid proof (non-hex character)
      if (proof.proofNodes.length > 0) {
        proof.proofNodes[0] = 'INVALID'.padEnd(64, 'g'); // Non-hex character 'g'
      }

      const isValid = tree.verifyConsistencyProof(root4, root8, proof);
      expect(isValid).toBe(false);
    });

    it('should verify consistency proof without accessing leaves', () => {
      // This test ensures the verification uses only the proof nodes
      for (let i = 0; i < 8; i++) {
        tree.append(createTestLeaf(i));
      }

      const root2 = tree.getRootAtSize(2);
      const root4 = tree.getRootAtSize(4);
      const root8 = tree.getRootAtSize(8);

      const proof1 = tree.getConsistencyProof(2, 4);
      const proof2 = tree.getConsistencyProof(4, 8);

      // Should be able to verify using only proof nodes
      expect(tree.verifyConsistencyProof(root2, root4, proof1)).toBe(true);
      expect(tree.verifyConsistencyProof(root4, root8, proof2)).toBe(true);
    });

    it('should verify consistency proof on a fresh verifier instance', () => {
      for (let i = 0; i < 13; i++) {
        tree.append(createTestLeaf(i));
      }

      const root5 = tree.getRootAtSize(5);
      const root13 = tree.getRootAtSize(13);
      const proof = tree.getConsistencyProof(5, 13);

      // Use a separate instance with no internal state to verify the proof
      const externalVerifier = new RFC6962MerkleTree();
      expect(externalVerifier.verifyConsistencyProof(root5, root13, proof)).toBe(true);

      // Tampering should break verification
      const tamperedProof = {
        ...proof,
        proofNodes: proof.proofNodes.map((node, index) =>
          index === 0 ? `${node.slice(0, 63)}${node.endsWith('0') ? '1' : '0'}` : node,
        ),
      };

      expect(externalVerifier.verifyConsistencyProof(root5, root13, tamperedProof)).toBe(false);
    });

    it('should properly verify 1→2 consistency proof', () => {
      const leaf0 = createTestLeaf(0);
      const leaf1 = createTestLeaf(1);
      tree.append(leaf0);
      tree.append(leaf1);

      const root1 = tree.getRootAtSize(1);
      const root2 = tree.getRootAtSize(2);
      const proof = tree.getConsistencyProof(1, 2);

      // The proof contains leaf1
      expect(strictDefined(proof.proofNodes[0])).toBe(leaf1);

      // Verification should work
      expect(tree.verifyConsistencyProof(root1, root2, proof)).toBe(true);

      // Structurally invalid proof should fail (wrong length)
      const tamperedProof = { ...proof, proofNodes: ['invalid'] }; // Too short
      expect(tree.verifyConsistencyProof(root1, root2, tamperedProof)).toBe(false);
    });

    it('should verify complex non-power-of-2 cases without accessing leaves', () => {
      // Build a tree with 13 leaves
      for (let i = 0; i < 13; i++) {
        tree.append(createTestLeaf(i));
      }

      // Test various transitions
      const testCases = [
        { oldSize: 3, newSize: 7 },
        { oldSize: 5, newSize: 11 },
        { oldSize: 6, newSize: 13 },
      ];

      for (const { oldSize, newSize } of testCases) {
        const oldRoot = tree.getRootAtSize(oldSize);
        const newRoot = tree.getRootAtSize(newSize);
        const proof = tree.getConsistencyProof(oldSize, newSize);

        // Should verify correctly
        expect(tree.verifyConsistencyProof(oldRoot, newRoot, proof)).toBe(true);

        // Should reject structurally invalid proof
        if (proof.proofNodes.length > 0) {
          const tamperedProof = { ...proof };
          tamperedProof.proofNodes = [...proof.proofNodes];
          // Use structurally invalid proof node (non-hex character)
          tamperedProof.proofNodes[0] = 'INVALID'.padEnd(64, 'z');

          expect(tree.verifyConsistencyProof(oldRoot, newRoot, tamperedProof)).toBe(false);
        }
      }
    });
  });

  describe('inclusion proof (PATH function)', () => {
    it('should generate inclusion proof for a leaf', () => {
      // Add 4 leaves to create a balanced tree
      const leaves = [];
      for (let i = 0; i < 4; i++) {
        const leaf = createTestLeaf(i);
        leaves.push(leaf);
        tree.append(leaf);
      }

      // Get inclusion proof for index 0
      const proof = tree.getInclusionProof(0, 4);

      expect(proof).toBeDefined();
      expect(proof.leafIndex).toBe(0);
      expect(proof.proofNodes).toBeDefined();
      expect(Array.isArray(proof.proofNodes)).toBe(true);
      expect(proof.proofNodes.length).toBeGreaterThan(0);
    });

    it('should generate different proofs for different leaves', () => {
      // Add 8 leaves
      for (let i = 0; i < 8; i++) {
        tree.append(createTestLeaf(i));
      }

      const proof0 = tree.getInclusionProof(0, 8);
      const proof3 = tree.getInclusionProof(3, 8);
      const proof7 = tree.getInclusionProof(7, 8);

      // All proofs should be different
      expect(proof0.proofNodes).not.toEqual(proof3.proofNodes);
      expect(proof3.proofNodes).not.toEqual(proof7.proofNodes);
      expect(proof0.proofNodes).not.toEqual(proof7.proofNodes);
    });

    it('should verify valid inclusion proof', () => {
      // Add 4 leaves
      const leaves = [];
      for (let i = 0; i < 4; i++) {
        const leaf = createTestLeaf(i);
        leaves.push(leaf);
        tree.append(leaf);
      }

      const rootHash = tree.getRoot();

      // Get proof for leaf at index 1
      const proof = tree.getInclusionProof(1, 4);

      // Verify the proof
      const isValid = tree.verifyInclusionProof(strictDefined(leaves[1]), 1, proof.proofNodes, rootHash, 4);

      expect(isValid).toBe(true);
    });

    it('should reject inclusion proof with extra nodes', () => {
      const leaves = [createTestLeaf(0), createTestLeaf(1)];
      leaves.forEach((leaf) => tree.append(leaf));

      const rootHash = tree.getRoot();
      const proof = tree.getInclusionProof(0, 2);
      const proofWithExtraNode = [...proof.proofNodes, createTestLeaf(2)];

      const isValid = tree.verifyInclusionProof(strictDefined(leaves[0]), 0, proofWithExtraNode, rootHash, 2);

      expect(isValid).toBe(false);
    });

    it('should reject invalid inclusion proof', () => {
      // Add 4 leaves
      const leaves = [];
      for (let i = 0; i < 4; i++) {
        const leaf = createTestLeaf(i);
        leaves.push(leaf);
        tree.append(leaf);
      }

      const rootHash = tree.getRoot();
      const proof = tree.getInclusionProof(1, 4);

      // Use structurally invalid proof (non-hex character)
      const tamperedProof = [...proof.proofNodes];
      tamperedProof[0] = 'INVALID'.padEnd(64, 'x');

      const isValid = tree.verifyInclusionProof(strictDefined(leaves[1]), 1, tamperedProof, rootHash, 4);

      expect(isValid).toBe(false);
    });

    it('should handle non-power-of-2 tree sizes', () => {
      // Add 7 leaves (non-power-of-2)
      const leaves = [];
      for (let i = 0; i < 7; i++) {
        const leaf = createTestLeaf(i);
        leaves.push(leaf);
        tree.append(leaf);
      }

      const rootHash = tree.getRoot();

      // Test inclusion proofs for all leaves
      for (let i = 0; i < 7; i++) {
        const proof = tree.getInclusionProof(i, 7);

        const isValid = tree.verifyInclusionProof(strictDefined(leaves[i]), i, proof.proofNodes, rootHash, 7);

        expect(isValid).toBe(true);
      }
    });

    it('should generate correct proof path length', () => {
      // For a tree of size n, the proof path length should be ceil(log2(n))
      const testSizes = [1, 2, 4, 8, 16, 3, 5, 7, 9];

      for (const size of testSizes) {
        // Clear and rebuild tree
        tree = new RFC6962MerkleTree();

        for (let i = 0; i < size; i++) {
          tree.append(createTestLeaf(i));
        }

        // Get proof for first leaf
        const proof = tree.getInclusionProof(0, size);

        // Expected path length is ceil(log2(size))
        const expectedLength = Math.ceil(Math.log2(size));

        expect(proof.proofNodes.length).toBe(expectedLength);
      }
    });

    it('should throw error for invalid indices', () => {
      tree.append(createTestLeaf(0));
      tree.append(createTestLeaf(1));

      // Negative index
      expect(() => tree.getInclusionProof(-1, 2)).toThrow();

      // Index >= tree size
      expect(() => tree.getInclusionProof(2, 2)).toThrow();
      expect(() => tree.getInclusionProof(10, 2)).toThrow();

      // Tree size mismatch
      expect(() => tree.getInclusionProof(0, 5)).toThrow();
    });
  });
});
