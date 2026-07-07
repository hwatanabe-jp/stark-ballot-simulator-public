import { computeIncludedBitmapRoot } from './bitmap';
import { isRecord } from './guards';
import { isValidHexString, normalizeHexString } from './hex';

export const INCLUDED_BITMAP_ARTIFACT_SCHEMA = 'stark-ballot.included_bitmap';
export const INCLUDED_BITMAP_ARTIFACT_VERSION = '1.0';
export const SEEN_BITMAP_ARTIFACT_SCHEMA = 'stark-ballot.seen_bitmap';
export const SEEN_BITMAP_ARTIFACT_VERSION = '1.0';

export interface IncludedBitmapArtifact {
  schema: typeof INCLUDED_BITMAP_ARTIFACT_SCHEMA;
  version: typeof INCLUDED_BITMAP_ARTIFACT_VERSION;
  treeSize: number;
  includedBitmapRoot: string;
  includedBitmap: boolean[];
}

export interface SeenBitmapArtifact {
  schema: typeof SEEN_BITMAP_ARTIFACT_SCHEMA;
  version: typeof SEEN_BITMAP_ARTIFACT_VERSION;
  treeSize: number;
  seenBitmapRoot: string;
  seenBitmap: boolean[];
}

function normalizeBitmapRoot(root: string): string {
  return `0x${normalizeHexString(root)}`;
}

function isBooleanArray(value: unknown): value is boolean[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'boolean');
}

function validateBitmapArtifact(input: { bitmap: boolean[]; root: string; treeSize: number; label: string }): string {
  if (!Number.isInteger(input.treeSize) || input.treeSize < 0) {
    throw new Error(`Invalid treeSize for ${input.label} bitmap artifact`);
  }
  if (input.bitmap.length !== input.treeSize) {
    throw new Error(`${input.label} bitmap length must match treeSize`);
  }
  const normalizedRoot = normalizeBitmapRoot(input.root);
  if (!isValidHexString(normalizedRoot, 32)) {
    throw new Error(`Invalid ${input.label}BitmapRoot for ${input.label} bitmap artifact`);
  }
  const computedRoot = computeIncludedBitmapRoot(input.bitmap);
  if (normalizeHexString(computedRoot) !== normalizeHexString(normalizedRoot)) {
    throw new Error(`${input.label} bitmap root mismatch`);
  }
  return normalizedRoot;
}

export function parseIncludedBitmapArtifact(value: unknown): IncludedBitmapArtifact | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value['schema'] !== INCLUDED_BITMAP_ARTIFACT_SCHEMA || value['version'] !== INCLUDED_BITMAP_ARTIFACT_VERSION) {
    return null;
  }
  if (typeof value['treeSize'] !== 'number' || typeof value['includedBitmapRoot'] !== 'string') {
    return null;
  }
  if (!isBooleanArray(value['includedBitmap'])) {
    return null;
  }
  try {
    const includedBitmapRoot = validateBitmapArtifact({
      bitmap: value['includedBitmap'],
      root: value['includedBitmapRoot'],
      treeSize: value['treeSize'],
      label: 'included',
    });
    return {
      schema: INCLUDED_BITMAP_ARTIFACT_SCHEMA,
      version: INCLUDED_BITMAP_ARTIFACT_VERSION,
      treeSize: value['treeSize'],
      includedBitmapRoot,
      includedBitmap: [...value['includedBitmap']],
    };
  } catch {
    return null;
  }
}

export function parseSeenBitmapArtifact(value: unknown): SeenBitmapArtifact | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value['schema'] !== SEEN_BITMAP_ARTIFACT_SCHEMA || value['version'] !== SEEN_BITMAP_ARTIFACT_VERSION) {
    return null;
  }
  if (typeof value['treeSize'] !== 'number' || typeof value['seenBitmapRoot'] !== 'string') {
    return null;
  }
  if (!isBooleanArray(value['seenBitmap'])) {
    return null;
  }
  try {
    const seenBitmapRoot = validateBitmapArtifact({
      bitmap: value['seenBitmap'],
      root: value['seenBitmapRoot'],
      treeSize: value['treeSize'],
      label: 'seen',
    });
    return {
      schema: SEEN_BITMAP_ARTIFACT_SCHEMA,
      version: SEEN_BITMAP_ARTIFACT_VERSION,
      treeSize: value['treeSize'],
      seenBitmapRoot,
      seenBitmap: [...value['seenBitmap']],
    };
  } catch {
    return null;
  }
}
