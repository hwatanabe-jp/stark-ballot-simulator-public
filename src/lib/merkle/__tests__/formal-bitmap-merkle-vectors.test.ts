import { describe, expect, it } from 'vitest';
import bitmapCasesJson from '../../../../docs/current/formal/generated-vectors/bitmap-cases.json';
import { computeIncludedBitmapRoot } from '../../zkvm/bitmap';
import {
  calculateBitOffset,
  calculateLeafIndex,
  generateBitmapMerkleProof,
  verifyBitmapMerkleProof,
} from '../bitmap-merkle-tree';

interface FormalBitmapProbe {
  bitIndex: number;
  byteIndex: number;
  bitIndexInByte: number;
  expectedValue: boolean;
}

interface FormalBitmapCase {
  name: string;
  bitLength: number;
  trueIndices: number[];
  probes: FormalBitmapProbe[];
}

const bitmapCases = bitmapCasesJson as FormalBitmapCase[];

function buildBitmap(testCase: FormalBitmapCase): boolean[] {
  const trueIndices = new Set(testCase.trueIndices);
  return Array.from({ length: testCase.bitLength }, (_, index) => trueIndices.has(index));
}

describe('formal bitmap Merkle vectors', () => {
  it.each(bitmapCases.flatMap((testCase) => testCase.probes.map((probe) => ({ testCase, probe }))))(
    '$testCase.name bit $probe.bitIndex uses the modeled packed address',
    ({ probe }) => {
      expect(calculateLeafIndex(probe.bitIndex)).toBe(Math.floor(probe.byteIndex / 32));
      expect(calculateBitOffset(probe.bitIndex)).toBe(probe.bitIndex % 256);
    },
  );

  it.each(bitmapCases.filter((testCase) => testCase.bitLength > 0))(
    '$name verifies generated proofs against the modeled bit values',
    (testCase) => {
      const bitmap = buildBitmap(testCase);
      const root = computeIncludedBitmapRoot(bitmap);

      for (const probe of testCase.probes) {
        const proof = generateBitmapMerkleProof(bitmap, probe.bitIndex);
        const result = verifyBitmapMerkleProof(proof.leafChunk, proof.auditPath, root, probe.bitIndex);

        expect(result.valid).toBe(true);
        expect(result.included).toBe(probe.expectedValue);
      }
    },
  );
});
