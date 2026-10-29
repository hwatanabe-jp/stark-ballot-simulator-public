import { isNonArrayObject as isRecord } from '@stark-ballot/validation/unknown-value-guards';
import type { FinalizationRecord } from './finalization-record';
import type {
  FinalizationBitmapData,
  FinalizationBitmapDisposition,
  FinalizationResultAuthority,
} from './finalization-types';
import type { FinalizationBitmapRecord } from './finalization-store';
import { finalizationBitmapDataCodec } from './finalization-storage';
import { isValidHexString, normalizeHexString } from '@stark-ballot/crypto-primitives';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';

const AVAILABLE_DISPOSITION_KEYS = new Set(['availability', 'data']);
const UNAVAILABLE_DISPOSITION_KEYS = new Set(['availability']);

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
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
    sameSeenBitmapData(left, right)
  );
}

function sameSeenBitmapData(left: FinalizationBitmapData, right: FinalizationBitmapData): boolean {
  return sameOptionalBitmapRoot(left.seenBitmapRoot, right.seenBitmapRoot) && sameSeenBitmapValues(left, right);
}

function sameOptionalBitmapRoot(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined) return right === undefined;
  return right !== undefined && normalizeHex32(left) === normalizeHex32(right ?? '');
}

function sameSeenBitmapValues(left: FinalizationBitmapData, right: FinalizationBitmapData): boolean {
  return (
    (left.seenBitmap === undefined) === (right.seenBitmap === undefined) &&
    (left.seenBitmap?.length ?? 0) === (right.seenBitmap?.length ?? 0) &&
    (left.seenBitmap?.every((value, index) => value === right.seenBitmap?.[index]) ?? true)
  );
}

export function admitPersistedFinalizationBitmapData(
  record: Extract<FinalizationRecord, { state: { status: 'succeeded' } }>,
  candidate: unknown,
): FinalizationBitmapRecord | undefined {
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
      data,
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
  value: unknown,
): FinalizationBitmapDisposition {
  if (!isRecord(value)) {
    throw new Error('Invalid finalization bitmap evidence');
  }
  if (value['availability'] === 'unavailable') return admitUnavailableBitmap(record, value);
  if (value['availability'] !== 'available' || !hasOnlyKeys(value, AVAILABLE_DISPOSITION_KEYS)) {
    throw new Error('Invalid finalization bitmap evidence');
  }

  const data = finalizationBitmapDataCodec.decode(value['data']);
  if (!data) {
    throw new Error('Invalid finalization bitmap evidence');
  }
  const includedBitmap = data.includedBitmap;
  const treeSize = data.treeSize;
  const finalizedAtMs = data.finalizedAtMs;
  const seenBitmap = data.seenBitmap;
  const journal = record.finalizationResult.journal;
  const includedRoot = admitIncludedBitmapRoot(data, journal);
  const seenRoot = admitSeenBitmapRoot(data, journal);

  const admittedData: FinalizationBitmapData = {
    includedBitmap: [...includedBitmap],
    includedBitmapRoot: includedRoot,
    treeSize,
    finalizedAtMs,
    ...(seenBitmap && seenRoot ? { seenBitmap: [...seenBitmap], seenBitmapRoot: seenRoot } : {}),
  };

  const embeddedBitmap = record.finalizationResult.artifacts.bitmap;
  if (embeddedBitmap.availability === 'available' && !sameBitmapData(embeddedBitmap.data, admittedData)) {
    throw new Error('Successful finalization bitmap evidence does not match its semantic record');
  }

  return {
    availability: 'available',
    data: admittedData,
  };
}

function admitUnavailableBitmap(
  record: Extract<FinalizationRecord, { state: { status: 'succeeded' } }>,
  value: Record<string, unknown>,
): FinalizationBitmapDisposition {
  if (!hasOnlyKeys(value, UNAVAILABLE_DISPOSITION_KEYS)) throw new Error('Invalid finalization bitmap evidence');
  if (record.finalizationResult.artifacts.bitmap.availability === 'available') {
    throw new Error('Successful finalization bitmap disposition contradicts embedded evidence');
  }
  return { availability: 'unavailable' };
}

function admitIncludedBitmapRoot(
  data: FinalizationBitmapData,
  journal: FinalizationResultAuthority['journal'],
): string {
  const { includedBitmap, treeSize } = data;
  const journalIncludedRoot = normalizeHex32(journal.includedBitmapRoot);
  const includedRoot = normalizeHex32(data.includedBitmapRoot);
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

  return includedRoot;
}

function admitSeenBitmapRoot(
  data: FinalizationBitmapData,
  journal: FinalizationResultAuthority['journal'],
): string | undefined {
  const { seenBitmap } = data;
  let seenRoot: string | undefined;
  if (seenBitmap !== undefined) {
    const journalSeenRoot = journal.seenBitmapRoot ? normalizeHex32(journal.seenBitmapRoot) : null;
    seenRoot = normalizeHex32(data.seenBitmapRoot) ?? undefined;
    if (
      seenBitmap.length !== journal.treeSize ||
      !journalSeenRoot ||
      seenRoot !== journalSeenRoot ||
      normalizeHex32(computeIncludedBitmapRoot(seenBitmap)) !== journalSeenRoot
    ) {
      throw new Error('Invalid finalization bitmap evidence');
    }
  }

  return seenRoot;
}
