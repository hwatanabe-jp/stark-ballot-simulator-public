import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeIncludedBitmapRoot } from '../zkvm/bitmap';
import { generateBitmapMerkleProof, verifyBitmapMerkleProof } from './bitmap-merkle-tree';

const nonEmptyBitmapArbitrary = fc.array(fc.boolean(), { minLength: 1, maxLength: 520 });

function mutateHex(value: string): string {
  const first = value[0] === '0' ? '1' : '0';
  return `${first}${value.slice(1)}`;
}

describe('bitmap Merkle property tests', () => {
  it('round-trips generated proofs and preserves the source bit value', () => {
    fc.assert(
      fc.property(nonEmptyBitmapArbitrary, fc.nat(), (bitmap, seed) => {
        const index = seed % bitmap.length;
        const proof = generateBitmapMerkleProof(bitmap, index);
        const root = computeIncludedBitmapRoot(bitmap);
        const result = verifyBitmapMerkleProof(proof.leafChunk, proof.auditPath, root, index);

        expect(result.valid).toBe(true);
        expect(result.included).toBe(bitmap[index]);
      }),
      { numRuns: 64 },
    );
  });

  it('rejects tampered chunks or audit paths', () => {
    fc.assert(
      fc.property(nonEmptyBitmapArbitrary, fc.nat(), (bitmap, seed) => {
        const index = seed % bitmap.length;
        const proof = generateBitmapMerkleProof(bitmap, index);
        const root = computeIncludedBitmapRoot(bitmap);
        const tamperedChunk = mutateHex(proof.leafChunk);

        expect(verifyBitmapMerkleProof(tamperedChunk, proof.auditPath, root, index).valid).toBe(false);

        if (proof.auditPath.length > 0) {
          const tamperedAuditPath = [
            {
              ...proof.auditPath[0],
              hash: mutateHex(proof.auditPath[0].hash),
            },
            ...proof.auditPath.slice(1),
          ];
          expect(verifyBitmapMerkleProof(proof.leafChunk, tamperedAuditPath, root, index).valid).toBe(false);
        }
      }),
      { numRuns: 64 },
    );
  });

  it.each([0, 1, 7, 8, 255, 256, 257, 511, 512])('keeps bitmap boundaries stable at %i bits', (length) => {
    const bitmap = Array.from({ length }, (_, index) => index === 0 || index === length - 1);

    const root = computeIncludedBitmapRoot(bitmap);
    expect(root).toMatch(/^0x[0-9a-f]{64}$/);

    if (length === 0) {
      expect(root).toBe(computeIncludedBitmapRoot([]));
      return;
    }

    const indices = Array.from(new Set([0, length - 1]));
    for (const index of indices) {
      const proof = generateBitmapMerkleProof(bitmap, index);
      const result = verifyBitmapMerkleProof(proof.leafChunk, proof.auditPath, root, index);
      expect(result.valid).toBe(true);
      expect(result.included).toBe(bitmap[index]);
    }
  });
});
