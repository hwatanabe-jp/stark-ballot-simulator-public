import { computeIncludedBitmapRoot } from '@/lib/zkvm/bitmap';
import { isValidHexString, normalizeHexString } from '@/lib/utils/hex';
import { isRecord } from '@/lib/utils/guards';
import { normalizeBitmapRoot } from '@/lib/verification/bitmap-root';

export const INCLUDED_BITMAP_ARTIFACT_SCHEMA = 'stark-ballot.included_bitmap';
export const INCLUDED_BITMAP_ARTIFACT_VERSION = '1.0';

export interface IncludedBitmapArtifact {
  schema: typeof INCLUDED_BITMAP_ARTIFACT_SCHEMA;
  version: typeof INCLUDED_BITMAP_ARTIFACT_VERSION;
  treeSize: number;
  includedBitmapRoot: string;
  includedBitmap: boolean[];
}

export function createIncludedBitmapArtifact(input: {
  includedBitmap: boolean[];
  includedBitmapRoot: string;
  treeSize: number;
}): IncludedBitmapArtifact {
  const { includedBitmap, treeSize } = input;
  if (!Number.isInteger(treeSize) || treeSize < 0) {
    throw new Error('Invalid treeSize for included bitmap artifact');
  }
  if (includedBitmap.length !== treeSize) {
    throw new Error('Included bitmap length must match treeSize');
  }

  const normalizedRoot = normalizeBitmapRoot(input.includedBitmapRoot);
  if (!isValidHexString(normalizedRoot, 32)) {
    throw new Error('Invalid includedBitmapRoot for included bitmap artifact');
  }

  const computedRoot = computeIncludedBitmapRoot(includedBitmap);
  if (normalizeHexString(computedRoot) !== normalizeHexString(normalizedRoot)) {
    throw new Error('Included bitmap root mismatch');
  }

  return {
    schema: INCLUDED_BITMAP_ARTIFACT_SCHEMA,
    version: INCLUDED_BITMAP_ARTIFACT_VERSION,
    treeSize,
    includedBitmapRoot: normalizedRoot,
    includedBitmap: [...includedBitmap],
  };
}

export function parseIncludedBitmapArtifact(value: unknown): IncludedBitmapArtifact | null {
  if (!isRecord(value)) {
    return null;
  }

  const schema = value.schema;
  const version = value.version;
  const treeSize = value.treeSize;
  const includedBitmapRoot = value.includedBitmapRoot;
  const includedBitmap = value.includedBitmap;

  if (schema !== INCLUDED_BITMAP_ARTIFACT_SCHEMA || version !== INCLUDED_BITMAP_ARTIFACT_VERSION) {
    return null;
  }

  if (typeof treeSize !== 'number' || !Number.isInteger(treeSize) || treeSize < 0) {
    return null;
  }

  if (typeof includedBitmapRoot !== 'string' || !isValidHexString(includedBitmapRoot, 32)) {
    return null;
  }

  if (!Array.isArray(includedBitmap) || !includedBitmap.every((entry) => typeof entry === 'boolean')) {
    return null;
  }

  try {
    return createIncludedBitmapArtifact({
      includedBitmap,
      includedBitmapRoot,
      treeSize,
    });
  } catch {
    return null;
  }
}
