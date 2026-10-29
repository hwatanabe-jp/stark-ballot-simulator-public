import { RFC6962MerkleTree } from '@stark-ballot/merkle/rfc6962-merkle-tree';

/** Fixture and benchmark trees append commitments in their declared vote order. */
export function buildCommitmentTree(commitments: readonly string[]): RFC6962MerkleTree {
  const tree = new RFC6962MerkleTree();
  for (const commitment of commitments) tree.append(commitment);
  return tree;
}
