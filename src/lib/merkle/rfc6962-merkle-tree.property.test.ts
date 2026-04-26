import { Buffer } from 'buffer';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RFC6962MerkleTree } from './rfc6962-merkle-tree';

const hexLeafArbitrary = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => Buffer.from(bytes).toString('hex'));

const leafSetArbitrary = fc.uniqueArray(hexLeafArbitrary, { minLength: 1, maxLength: 12 });
const nonTrivialLeafSetArbitrary = fc.uniqueArray(hexLeafArbitrary, { minLength: 2, maxLength: 12 });

function mutateHex(value: string): string {
  const bytes = Buffer.from(value, 'hex');
  bytes[0] ^= 0x01;
  return bytes.toString('hex');
}

function buildTree(leaves: readonly string[]): RFC6962MerkleTree {
  const tree = new RFC6962MerkleTree();
  for (const leaf of leaves) {
    tree.append(leaf);
  }
  return tree;
}

describe('RFC6962MerkleTree properties', () => {
  it('round-trips inclusion proofs for every generated leaf and rejects tampering', () => {
    fc.assert(
      fc.property(leafSetArbitrary, (leaves) => {
        const tree = buildTree(leaves);
        const root = tree.getRoot();

        leaves.forEach((leaf, index) => {
          const proof = tree.getInclusionProof(index, leaves.length);
          expect(tree.verifyInclusionProof(leaf, index, proof.proofNodes, root, leaves.length)).toBe(true);

          const tamperedProofNodes =
            proof.proofNodes.length > 0 ? [mutateHex(proof.proofNodes[0]), ...proof.proofNodes.slice(1)] : [];
          const tamperedLeaf = proof.proofNodes.length === 0 ? mutateHex(leaf) : leaf;

          expect(tree.verifyInclusionProof(tamperedLeaf, index, tamperedProofNodes, root, leaves.length)).toBe(false);

          expect(tree.verifyInclusionProof(leaf, index, proof.proofNodes, mutateHex(root), leaves.length)).toBe(false);

          if (leaves.length > 1) {
            const tamperedIndex = (index + 1) % leaves.length;
            expect(tree.verifyInclusionProof(leaf, tamperedIndex, proof.proofNodes, root, leaves.length)).toBe(false);
          }

          const proofWithExtraNode = [...proof.proofNodes, mutateHex(leaf)];
          expect(tree.verifyInclusionProof(leaf, index, proofWithExtraNode, root, leaves.length)).toBe(false);
        });
      }),
      { numRuns: 48 },
    );
  });

  it('round-trips consistency proofs for all generated growth pairs and rejects tampering', () => {
    fc.assert(
      fc.property(nonTrivialLeafSetArbitrary, (leaves) => {
        const tree = buildTree(leaves);

        for (let oldSize = 1; oldSize <= leaves.length; oldSize++) {
          for (let newSize = oldSize; newSize <= leaves.length; newSize++) {
            const oldRoot = tree.getRootAtSize(oldSize);
            const newRoot = tree.getRootAtSize(newSize);
            const proof = tree.getConsistencyProof(oldSize, newSize);

            expect(tree.verifyConsistencyProof(oldRoot, newRoot, proof)).toBe(true);

            if (oldSize < newSize) {
              expect(proof.proofNodes.length).toBeGreaterThan(0);
              const tamperedProof = {
                ...proof,
                proofNodes: [mutateHex(proof.proofNodes[0]), ...proof.proofNodes.slice(1)],
              };
              expect(tree.verifyConsistencyProof(oldRoot, newRoot, tamperedProof)).toBe(false);
            }
          }
        }
      }),
      { numRuns: 32 },
    );
  });

  it.each([3, 5, 7, 9])('keeps odd-size append-only regressions covered for %i leaves', (size) => {
    const leaves = Array.from({ length: size }, (_, index) => index.toString(16).padStart(64, '0'));
    const tree = buildTree(leaves);
    const root = tree.getRoot();

    leaves.forEach((leaf, index) => {
      const proof = tree.getInclusionProof(index, size);
      expect(tree.verifyInclusionProof(leaf, index, proof.proofNodes, root, size)).toBe(true);
    });

    for (let oldSize = 1; oldSize < size; oldSize++) {
      const oldRoot = tree.getRootAtSize(oldSize);
      const proof = tree.getConsistencyProof(oldSize, size);
      expect(tree.verifyConsistencyProof(oldRoot, root, proof)).toBe(true);
    }
  });
});
