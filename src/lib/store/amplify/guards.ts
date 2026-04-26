import type { ReceiptJournal, ReceiptWithImageId } from '@/lib/verification/image-id-types';
import type { ZkVMJournal } from '@/lib/zkvm/types';
import {
  parseFinalizationStoragePayload as parseStoredFinalizationStoragePayload,
  type ParsedFinalizationStoragePayload,
} from '@/lib/finalize/finalization-storage';
import { isSupportedZkVMJournal } from '@/lib/zkvm/journal-guards';
import { isRecord } from '@/lib/utils/guards';
import { logger } from '@/lib/utils/logger';

export function isReceiptJournal(value: unknown): value is ReceiptJournal {
  if (typeof value === 'string') {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  const bytes = value.bytes;
  return Array.isArray(bytes) && bytes.every((item) => Number.isInteger(item));
}

export function isReceiptWithImageId(value: unknown): value is ReceiptWithImageId {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.seal === 'string' && isReceiptJournal(value.journal);
}

export function isZkVMJournal(value: unknown): value is ZkVMJournal {
  return isSupportedZkVMJournal(value);
}

export function isNonNegativeInteger(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function toNumber(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'number') {
    return value;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : undefined;
}

export function parseJsonField<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      logger.warn('[AmplifySessionStore] Failed to parse JSON field', error);
      return undefined;
    }
  }
  if (typeof value === 'object') {
    return value as T;
  }
  return undefined;
}

export function parseFinalizationStoragePayload(value: unknown): ParsedFinalizationStoragePayload | undefined {
  return parseStoredFinalizationStoragePayload(value);
}
