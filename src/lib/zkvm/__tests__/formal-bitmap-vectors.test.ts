import { describe, expect, it } from 'vitest';
import bitmapCasesJson from '../../../../docs/current/formal/generated-vectors/bitmap-cases.json';
import { extractBitFromChunkBuffer, getBitmapLeafChunkBuffer, packBitsToBytes } from '../bitmap';

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
  expectedPackedByteLength: number;
  expectedPackedBytesHex: string;
  probes: FormalBitmapProbe[];
}

const bitmapCases = bitmapCasesJson as FormalBitmapCase[];

function buildBitmap(testCase: FormalBitmapCase): boolean[] {
  const trueIndices = new Set(testCase.trueIndices);
  return Array.from({ length: testCase.bitLength }, (_, index) => trueIndices.has(index));
}

describe('formal bitmap packing vectors', () => {
  it.each(bitmapCases)('$name packs LSB-first', (testCase) => {
    const bitmap = buildBitmap(testCase);
    const packed = packBitsToBytes(bitmap);

    expect(packed).toHaveLength(testCase.expectedPackedByteLength);
    expect(packed.toString('hex')).toBe(testCase.expectedPackedBytesHex);

    for (const probe of testCase.probes) {
      expect(probe.byteIndex).toBe(Math.floor(probe.bitIndex / 8));
      expect(probe.bitIndexInByte).toBe(probe.bitIndex % 8);
      expect(Boolean(packed[probe.byteIndex] & (1 << probe.bitIndexInByte))).toBe(probe.expectedValue);
    }
  });

  it.each(bitmapCases.filter((testCase) => testCase.bitLength > 0))(
    '$name extracts the same bit from padded leaf chunks',
    (testCase) => {
      const bitmap = buildBitmap(testCase);

      for (const probe of testCase.probes) {
        const leafIndex = Math.floor(probe.bitIndex / 256);
        const bitOffset = probe.bitIndex % 256;
        const chunk = getBitmapLeafChunkBuffer(bitmap, leafIndex);

        expect(extractBitFromChunkBuffer(chunk, bitOffset)).toBe(probe.expectedValue);
      }
    },
  );
});
