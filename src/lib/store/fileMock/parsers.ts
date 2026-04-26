import { getBooleanArrayProperty, getNumberProperty, getStringProperty, isRecord } from '@/lib/utils/guards';
import type { BitmapData, ReceiptEntry } from './types';

export function parseBitmapData(value: unknown): BitmapData | null {
  if (!isRecord(value)) {
    return null;
  }
  const sessionId = getStringProperty(value, 'sessionId');
  const includedBitmap = getBooleanArrayProperty(value, 'includedBitmap');
  const includedBitmapRoot = getStringProperty(value, 'includedBitmapRoot');
  const seenBitmap = getBooleanArrayProperty(value, 'seenBitmap');
  const seenBitmapRoot = getStringProperty(value, 'seenBitmapRoot');
  const treeSize = getNumberProperty(value, 'treeSize');
  const finalizedAt = getNumberProperty(value, 'finalizedAt');

  if (!sessionId || !includedBitmap || !includedBitmapRoot || treeSize === undefined || finalizedAt === undefined) {
    return null;
  }

  return {
    sessionId,
    includedBitmap,
    includedBitmapRoot,
    ...(seenBitmap && seenBitmapRoot ? { seenBitmap, seenBitmapRoot } : {}),
    treeSize,
    finalizedAt,
  };
}

function isReceiptEntry(value: unknown): value is ReceiptEntry {
  if (!isRecord(value)) {
    return false;
  }
  if (!isRecord(value.receipt)) {
    return false;
  }
  return (
    typeof value.receiptHash === 'string' &&
    typeof value.boardIndex === 'number' &&
    typeof value.receipt.receipt === 'string' &&
    typeof value.receipt.timestamp === 'number'
  );
}

export function parseReceiptEntries(value: unknown): Record<string, ReceiptEntry> | null {
  if (!isRecord(value)) {
    return null;
  }
  const entries: Record<string, ReceiptEntry> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isReceiptEntry(entry)) {
      return null;
    }
    entries[key] = entry;
  }
  return entries;
}
