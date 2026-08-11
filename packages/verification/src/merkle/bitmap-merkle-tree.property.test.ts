import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { computeIncludedBitmapRootHex } from '@stark-ballot/zkvm-contract/zkvm/bitmap-core';
import {
  buildAuthenticatedBitmapProofContext,
  generateBitmapMerkleProof,
  verifyBitmapMerkleProof,
} from './bitmap-merkle-tree';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

const nonEmptyBitmapArbitrary = fc.array(fc.boolean(), { minLength: 1, maxLength: 1030 });

function mutateHex(value: string): string {
  const first = value[0] === '0' ? '1' : '0';
  return `${first}${value.slice(1)}`;
}

function verifyProof(input: {
  leafChunk: string;
  auditPath: Array<{ hash: string; position: 'left' | 'right' }>;
  root: string;
  bitIndex: number;
  treeSize: number;
}) {
  return verifyBitmapMerkleProof(
    input.leafChunk,
    input.auditPath,
    buildAuthenticatedBitmapProofContext({
      bitIndex: input.bitIndex,
      treeSize: input.treeSize,
      expectedRoot: input.root,
    }),
  );
}

describe('bitmap Merkle property tests', () => {
  it('keeps the browser-safe root byte-for-byte compatible with the zkVM contract', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { maxLength: 1030 }), (bitmap) => {
        expect(computeIncludedBitmapRootHex(bitmap)).toBe(computeIncludedBitmapRoot(bitmap));
      }),
      { numRuns: 64 },
    );
  });

  it('round-trips generated proofs and preserves the source bit value', () => {
    fc.assert(
      fc.property(nonEmptyBitmapArbitrary, fc.nat(), (bitmap, seed) => {
        const index = seed % bitmap.length;
        const proof = generateBitmapMerkleProof(bitmap, index);
        const root = computeIncludedBitmapRoot(bitmap);
        const result = verifyProof({
          leafChunk: proof.leafChunk,
          auditPath: proof.auditPath,
          root,
          bitIndex: index,
          treeSize: bitmap.length,
        });

        expect(result.valid).toBe(true);
        expect(result.included).toBe(strictDefined(bitmap[index]));
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

        expect(
          verifyProof({
            leafChunk: tamperedChunk,
            auditPath: proof.auditPath,
            root,
            bitIndex: index,
            treeSize: bitmap.length,
          }).valid,
        ).toBe(false);

        if (proof.auditPath.length > 0) {
          const tamperedAuditPath = [
            {
              ...strictDefined(proof.auditPath[0]),
              hash: mutateHex(strictDefined(proof.auditPath[0]).hash),
            },
            ...proof.auditPath.slice(1),
          ];
          expect(
            verifyProof({
              leafChunk: proof.leafChunk,
              auditPath: tamperedAuditPath,
              root,
              bitIndex: index,
              treeSize: bitmap.length,
            }).valid,
          ).toBe(false);
        }
      }),
      { numRuns: 64 },
    );
  });

  it('rejects proofs when the authenticated logical tree size excludes the requested bit', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 2, maxLength: 255 }), (bitmap) => {
        const index = bitmap.length - 1;
        const proof = generateBitmapMerkleProof(bitmap, index);
        const root = computeIncludedBitmapRoot(bitmap);

        expect(
          verifyProof({
            leafChunk: proof.leafChunk,
            auditPath: proof.auditPath,
            root,
            bitIndex: index,
            treeSize: bitmap.length,
          }).valid,
        ).toBe(true);
        expect(
          verifyProof({
            leafChunk: proof.leafChunk,
            auditPath: proof.auditPath,
            root,
            bitIndex: index,
            treeSize: bitmap.length - 1,
          }).valid,
        ).toBe(false);
      }),
      { numRuns: 64 },
    );
  });

  it('rejects nonzero padding bits beyond the authenticated logical tree size', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 255 }), (length) => {
        const bitmap = Array.from({ length }, (_, index) => index === 0);
        const proof = generateBitmapMerkleProof(bitmap, 0);
        const root = computeIncludedBitmapRoot(bitmap);
        const chunk = Buffer.from(proof.leafChunk, 'hex');
        const paddingBit = length;
        const byteIndex = Math.floor(paddingBit / 8);
        const bitInByte = paddingBit % 8;
        const byte = chunk[byteIndex];
        if (byte === undefined) {
          throw new Error('Expected padding byte to exist');
        }
        chunk[byteIndex] = byte | (1 << bitInByte);

        expect(
          verifyProof({
            leafChunk: chunk.toString('hex'),
            auditPath: proof.auditPath,
            root,
            bitIndex: 0,
            treeSize: length,
          }).valid,
        ).toBe(false);
      }),
      { numRuns: 64 },
    );
  });

  it.each([0, 1, 7, 8, 255, 256, 257, 511, 512, 513, 1025])('keeps bitmap boundaries stable at %i bits', (length) => {
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
      const result = verifyProof({
        leafChunk: proof.leafChunk,
        auditPath: proof.auditPath,
        root,
        bitIndex: index,
        treeSize: bitmap.length,
      });
      expect(result.valid).toBe(true);
      expect(result.included).toBe(strictDefined(bitmap[index]));
    }
  });
});
