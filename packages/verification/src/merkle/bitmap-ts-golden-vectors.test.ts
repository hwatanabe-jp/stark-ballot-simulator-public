import { describe, expect, it } from 'vitest';
import goldenVectorsJson from '../../../../zkvm/contract-core/testdata/bitmap-ts-golden-vectors.json';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import {
  CURRENT_BITMAP_GOLDEN_VECTOR_TYPE,
  parseCurrentBitmapGoldenVectors,
  type BitmapGoldenCase,
} from '@stark-ballot/zkvm-contract/zkvm/bitmap-golden-vectors';
import { generateBitmapMerkleProof } from './bitmap-merkle-tree';

const goldenVectors = parseCurrentBitmapGoldenVectors(goldenVectorsJson);

function buildBitmap(testCase: BitmapGoldenCase): boolean[] {
  const trueIndices = new Set(testCase.trueIndices);
  return Array.from({ length: testCase.bitLength }, (_, index) => trueIndices.has(index));
}

describe('bitmap TypeScript golden vectors', () => {
  it('uses the current bitmap proof parity schema', () => {
    expect(goldenVectors.envelopeType).toBe(CURRENT_BITMAP_GOLDEN_VECTOR_TYPE);
  });

  it.each(goldenVectors.cases)('$name root and proofs match current TypeScript implementation', (testCase) => {
    const bitmap = buildBitmap(testCase);

    expect(computeIncludedBitmapRoot(bitmap)).toBe(testCase.root);

    for (const expectedProof of testCase.proofs) {
      expect(generateBitmapMerkleProof(bitmap, expectedProof.bitIndex)).toEqual(expectedProof);
    }
  });
});
