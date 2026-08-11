import type { FinalizationRecord } from './finalization-record';
import type { FinalizationBitmapData, FinalizationBitmapDisposition } from './finalization-types';
import { isValidHexString, normalizeHexString } from '@stark-ballot/crypto-primitives';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';

const AVAILABLE_DISPOSITION_KEYS = new Set(['availability', 'data']);
const UNAVAILABLE_DISPOSITION_KEYS = new Set(['availability']);
const BITMAP_DATA_KEYS = new Set([
  'includedBitmap',
  'includedBitmapRoot',
  'seenBitmap',
  'seenBitmapRoot',
  'treeSize',
  'finalizedAtMs',
]);
const REQUIRED_BITMAP_DATA_KEYS = new Set(['includedBitmap', 'includedBitmapRoot', 'treeSize', 'finalizedAtMs']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasAllKeys(value: Record<string, unknown>, required: ReadonlySet<string>): boolean {
  return Array.from(required).every((key) => Object.hasOwn(value, key));
}

function isBooleanArray(value: unknown): value is boolean[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'boolean');
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function normalizeHex32(value: unknown): string | null {
  if (typeof value !== 'string' || !isValidHexString(value, 32)) {
    return null;
  }
  const normalized = normalizeHexString(value);
  return normalized.startsWith('0x') ? normalized : `0x${normalized}`;
}

function sameBitmapData(left: FinalizationBitmapData, right: FinalizationBitmapData): boolean {
  return (
    left.treeSize === right.treeSize &&
    left.finalizedAtMs === right.finalizedAtMs &&
    normalizeHex32(left.includedBitmapRoot) === normalizeHex32(right.includedBitmapRoot) &&
    left.includedBitmap.length === right.includedBitmap.length &&
    left.includedBitmap.every((value, index) => value === right.includedBitmap[index]) &&
    (left.seenBitmapRoot === undefined) === (right.seenBitmapRoot === undefined) &&
    (left.seenBitmapRoot === undefined ||
      normalizeHex32(left.seenBitmapRoot) === normalizeHex32(right.seenBitmapRoot ?? '')) &&
    (left.seenBitmap === undefined) === (right.seenBitmap === undefined) &&
    (left.seenBitmap?.length ?? 0) === (right.seenBitmap?.length ?? 0) &&
    (left.seenBitmap?.every((value, index) => value === right.seenBitmap?.[index]) ?? true)
  );
}

export type PersistedFinalizationBitmapData = FinalizationBitmapData & {
  sessionId: string;
  finalizationId: string;
};

export function admitPersistedFinalizationBitmapData(
  record: Extract<FinalizationRecord, { state: { status: 'succeeded' } }>,
  candidate: PersistedFinalizationBitmapData | null | undefined,
): PersistedFinalizationBitmapData | undefined {
  if (
    !isRecord(candidate) ||
    candidate['sessionId'] !== record.sessionId ||
    candidate['finalizationId'] !== record.finalizationId
  ) {
    return undefined;
  }
  try {
    const { sessionId: _sessionId, finalizationId: _finalizationId, ...data } = candidate;
    void _sessionId;
    void _finalizationId;
    const admitted = admitFinalizationBitmapDisposition(record, {
      availability: 'available',
      data: data as unknown as FinalizationBitmapData,
    });
    if (admitted.availability !== 'available') {
      return undefined;
    }
    return {
      sessionId: record.sessionId,
      finalizationId: record.finalizationId,
      ...admitted.data,
    };
  } catch {
    return undefined;
  }
}

export function admitFinalizationBitmapDisposition(
  record: Extract<FinalizationRecord, { state: { status: 'succeeded' } }>,
  disposition: FinalizationBitmapDisposition,
): FinalizationBitmapDisposition {
  const value: unknown = disposition;
  if (!isRecord(value)) {
    throw new Error('Invalid finalization bitmap evidence');
  }
  if (value['availability'] === 'unavailable') {
    if (!hasOnlyKeys(value, UNAVAILABLE_DISPOSITION_KEYS)) {
      throw new Error('Invalid finalization bitmap evidence');
    }
    if (record.finalizationResult.bitmapData !== undefined) {
      throw new Error('Successful finalization bitmap disposition contradicts embedded evidence');
    }
    return { availability: 'unavailable' };
  }
  if (value['availability'] !== 'available' || !hasOnlyKeys(value, AVAILABLE_DISPOSITION_KEYS)) {
    throw new Error('Invalid finalization bitmap evidence');
  }

  const data = value['data'];
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, BITMAP_DATA_KEYS) ||
    !hasAllKeys(data, REQUIRED_BITMAP_DATA_KEYS) ||
    !isBooleanArray(data['includedBitmap']) ||
    !isNonNegativeSafeInteger(data['treeSize']) ||
    !isNonNegativeSafeInteger(data['finalizedAtMs']) ||
    Object.hasOwn(data, 'seenBitmap') !== Object.hasOwn(data, 'seenBitmapRoot') ||
    (Object.hasOwn(data, 'seenBitmap') && !isBooleanArray(data['seenBitmap']))
  ) {
    throw new Error('Invalid finalization bitmap evidence');
  }
  const includedBitmap = data['includedBitmap'];
  const treeSize = data['treeSize'];
  const finalizedAtMs = data['finalizedAtMs'];
  const seenBitmap = data['seenBitmap'] as boolean[] | undefined;
  const journal = record.finalizationResult.journal;
  const journalIncludedRoot = normalizeHex32(journal.includedBitmapRoot);
  const includedRoot = normalizeHex32(data['includedBitmapRoot']);
  const computedIncludedRoot = normalizeHex32(computeIncludedBitmapRoot(includedBitmap));
  if (
    !journalIncludedRoot ||
    includedRoot !== journalIncludedRoot ||
    computedIncludedRoot !== journalIncludedRoot ||
    treeSize !== journal.treeSize ||
    includedBitmap.length !== journal.treeSize
  ) {
    throw new Error('Invalid finalization bitmap evidence');
  }

  let seenRoot: string | undefined;
  if (seenBitmap !== undefined) {
    const journalSeenRoot = journal.seenBitmapRoot ? normalizeHex32(journal.seenBitmapRoot) : null;
    seenRoot = normalizeHex32(data['seenBitmapRoot']) ?? undefined;
    if (
      seenBitmap.length !== journal.treeSize ||
      !journalSeenRoot ||
      seenRoot !== journalSeenRoot ||
      normalizeHex32(computeIncludedBitmapRoot(seenBitmap)) !== journalSeenRoot
    ) {
      throw new Error('Invalid finalization bitmap evidence');
    }
  }

  const admittedData: FinalizationBitmapData = {
    includedBitmap: [...includedBitmap],
    includedBitmapRoot: includedRoot,
    treeSize,
    finalizedAtMs,
    ...(seenBitmap && seenRoot ? { seenBitmap: [...seenBitmap], seenBitmapRoot: seenRoot } : {}),
  };

  if (record.finalizationResult.bitmapData && !sameBitmapData(record.finalizationResult.bitmapData, admittedData)) {
    throw new Error('Successful finalization bitmap evidence does not match its semantic record');
  }

  return {
    availability: 'available',
    data: admittedData,
  };
}
