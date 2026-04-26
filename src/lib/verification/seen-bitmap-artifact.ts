import { computeIncludedBitmapRoot } from '@/lib/zkvm/bitmap';
import { isValidHexString, normalizeHexString } from '@/lib/utils/hex';
import { isRecord } from '@/lib/utils/guards';
import { normalizeBitmapRoot } from '@/lib/verification/bitmap-root';

export const SEEN_BITMAP_ARTIFACT_SCHEMA = 'stark-ballot.seen_bitmap';
export const SEEN_BITMAP_ARTIFACT_VERSION = '1.0';

export interface SeenBitmapArtifact {
  schema: typeof SEEN_BITMAP_ARTIFACT_SCHEMA;
  version: typeof SEEN_BITMAP_ARTIFACT_VERSION;
  treeSize: number;
  seenBitmapRoot: string;
  seenBitmap: boolean[];
}

export function createSeenBitmapArtifact(input: {
  seenBitmap: boolean[];
  seenBitmapRoot: string;
  treeSize: number;
}): SeenBitmapArtifact {
  const { seenBitmap, treeSize } = input;
  if (!Number.isInteger(treeSize) || treeSize < 0) {
    throw new Error('Invalid treeSize for seen bitmap artifact');
  }
  if (seenBitmap.length !== treeSize) {
    throw new Error('Seen bitmap length must match treeSize');
  }

  const normalizedRoot = normalizeBitmapRoot(input.seenBitmapRoot);
  if (!isValidHexString(normalizedRoot, 32)) {
    throw new Error('Invalid seenBitmapRoot for seen bitmap artifact');
  }

  const computedRoot = computeIncludedBitmapRoot(seenBitmap);
  if (normalizeHexString(computedRoot) !== normalizeHexString(normalizedRoot)) {
    throw new Error('Seen bitmap root mismatch');
  }

  return {
    schema: SEEN_BITMAP_ARTIFACT_SCHEMA,
    version: SEEN_BITMAP_ARTIFACT_VERSION,
    treeSize,
    seenBitmapRoot: normalizedRoot,
    seenBitmap: [...seenBitmap],
  };
}

export function parseSeenBitmapArtifact(value: unknown): SeenBitmapArtifact | null {
  if (!isRecord(value)) {
    return null;
  }

  const schema = value.schema;
  const version = value.version;
  const treeSize = value.treeSize;
  const seenBitmapRoot = value.seenBitmapRoot;
  const seenBitmap = value.seenBitmap;

  if (schema !== SEEN_BITMAP_ARTIFACT_SCHEMA || version !== SEEN_BITMAP_ARTIFACT_VERSION) {
    return null;
  }

  if (typeof treeSize !== 'number' || !Number.isInteger(treeSize) || treeSize < 0) {
    return null;
  }

  if (typeof seenBitmapRoot !== 'string' || !isValidHexString(seenBitmapRoot, 32)) {
    return null;
  }

  if (!Array.isArray(seenBitmap) || !seenBitmap.every((entry) => typeof entry === 'boolean')) {
    return null;
  }

  try {
    return createSeenBitmapArtifact({
      seenBitmap,
      seenBitmapRoot,
      treeSize,
    });
  } catch {
    return null;
  }
}
