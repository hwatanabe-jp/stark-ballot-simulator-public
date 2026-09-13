import { describe, expect, it } from 'vitest';
import bitmapArtifactsSentinel from '../../../../zkvm/contract-core/testdata/current-bitmap-artifacts-sentinel.json';
import { computeIncludedBitmapRoot } from './bitmap';
import {
  createIncludedBitmapArtifact,
  createSeenBitmapArtifact,
  parseIncludedBitmapArtifact,
  parseSeenBitmapArtifact,
} from './bitmap-artifacts';

describe('bitmap artifact contract', () => {
  it('admits the Rust-owned current bitmap artifact sentinel', () => {
    expect(parseIncludedBitmapArtifact(bitmapArtifactsSentinel.included)).toEqual(bitmapArtifactsSentinel.included);
    expect(parseSeenBitmapArtifact(bitmapArtifactsSentinel.seen)).toEqual(bitmapArtifactsSentinel.seen);
  });

  it.each([
    {
      create: (bitmap: boolean[], root: string) =>
        createIncludedBitmapArtifact({ includedBitmap: bitmap, includedBitmapRoot: root, treeSize: bitmap.length }),
      parse: parseIncludedBitmapArtifact,
      bitmapKey: 'includedBitmap',
    },
    {
      create: (bitmap: boolean[], root: string) =>
        createSeenBitmapArtifact({ seenBitmap: bitmap, seenBitmapRoot: root, treeSize: bitmap.length }),
      parse: parseSeenBitmapArtifact,
      bitmapKey: 'seenBitmap',
    },
  ] as const)('creates and exactly admits the $bitmapKey artifact', ({ create, parse }) => {
    const bitmap = [true, false, true];
    const artifact = create(bitmap, computeIncludedBitmapRoot(bitmap));

    expect(parse(artifact)).toEqual(artifact);
    expect(parse({ ...artifact, compatibilityMarker: 'retired' })).toBeNull();
  });
});
