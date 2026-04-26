import { createHash } from 'node:crypto';
import { RFC6962MerkleTree } from '@/lib/merkle/rfc6962-merkle-tree';

export const RFC6962_GOLDEN_VECTOR_SIZES = [1, 2, 3, 5, 7, 8, 9, 64] as const;

export interface Rfc6962GoldenProof {
  leafIndex: number;
  auditPath: string[];
}

export interface Rfc6962GoldenCase {
  treeSize: number;
  leaves: string[];
  root: string;
  proofs: Rfc6962GoldenProof[];
}

export interface Rfc6962GoldenVectors {
  schema: 'stark-ballot:rfc6962-ts-golden-vectors|v1';
  generatedBy: 'scripts/tests/generate-rfc6962-golden-vectors.ts';
  cases: Rfc6962GoldenCase[];
}

function deterministicLeaf(treeSize: number, leafIndex: number): string {
  return createHash('sha256')
    .update('stark-ballot:rfc6962-ts-golden-vector|v1')
    .update(`|tree-size:${treeSize}|leaf-index:${leafIndex}`)
    .digest('hex');
}

function buildCase(treeSize: number): Rfc6962GoldenCase {
  const tree = new RFC6962MerkleTree();
  const leaves = Array.from({ length: treeSize }, (_, leafIndex) => deterministicLeaf(treeSize, leafIndex));

  for (const leaf of leaves) {
    tree.append(leaf);
  }

  return {
    treeSize,
    leaves,
    root: tree.getRoot(),
    proofs: leaves.map((_, leafIndex) => ({
      leafIndex,
      auditPath: tree.getInclusionProof(leafIndex, treeSize).proofNodes,
    })),
  };
}

export function buildRfc6962GoldenVectors(): Rfc6962GoldenVectors {
  return {
    schema: 'stark-ballot:rfc6962-ts-golden-vectors|v1',
    generatedBy: 'scripts/tests/generate-rfc6962-golden-vectors.ts',
    cases: RFC6962_GOLDEN_VECTOR_SIZES.map((treeSize) => buildCase(treeSize)),
  };
}
