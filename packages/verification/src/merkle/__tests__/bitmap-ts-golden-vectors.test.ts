import { describe, expect, it } from 'vitest';
import goldenVectorsJson from '../../../../../zkvm/contract-core/testdata/bitmap-ts-golden-vectors.json';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { generateBitmapMerkleProof } from '../bitmap-merkle-tree';

interface BitmapGoldenProof {
  leafChunk: string;
  auditPath: Array<{ hash: string; position: 'left' | 'right' }>;
  leafIndex: number;
  bitIndex: number;
}

interface BitmapGoldenCase {
  name: string;
  bitLength: number;
  trueIndices: number[];
  root: string;
  proofs: BitmapGoldenProof[];
}

interface BitmapGoldenVectors {
  schema: string;
  cases: BitmapGoldenCase[];
}

const goldenVectors = goldenVectorsJson as BitmapGoldenVectors;

function buildBitmap(testCase: BitmapGoldenCase): boolean[] {
  const trueIndices = new Set(testCase.trueIndices);
  return Array.from({ length: testCase.bitLength }, (_, index) => trueIndices.has(index));
}

describe('bitmap TypeScript golden vectors', () => {
  it('uses the current bitmap proof parity schema', () => {
    expect(goldenVectors.schema).toBe('stark-ballot.bitmap-proof-parity.v1');
  });

  it.each(goldenVectors.cases)('$name root and proofs match current TypeScript implementation', (testCase) => {
    const bitmap = buildBitmap(testCase);

    expect(computeIncludedBitmapRoot(bitmap)).toBe(testCase.root);

    for (const expectedProof of testCase.proofs) {
      expect(generateBitmapMerkleProof(bitmap, expectedProof.bitIndex)).toEqual(expectedProof);
    }
  });
});
