import { RFC6962MerkleTree } from '@stark-ballot/merkle/rfc6962-merkle-tree';
import { normalizeHexString } from '@stark-ballot/verification/shared/hex';

export function verifyCTMerkleInclusion(
  commitment: string,
  path: string[],
  leafIndex: number,
  root: string,
  treeSize: number,
): boolean {
  if (treeSize <= 0) {
    throw new Error('Invalid tree size for CT inclusion proof');
  }

  const ctTree = new RFC6962MerkleTree();
  const normalizedCommitment = normalizeHexString(commitment);
  const normalizedRoot = normalizeHexString(root);
  const normalizedPath = path.map((node) => normalizeHexString(node));

  return ctTree.verifyInclusionProof(normalizedCommitment, leafIndex, normalizedPath, normalizedRoot, treeSize);
}
