import { Buffer } from 'buffer';
import type { ReceiptWithImageId } from '@stark-ballot/verification/image-id-types';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

declare const admittedReceiptPayloadBrand: unique symbol;

export type AdmittedReceiptPayload = Record<string, unknown> & {
  readonly [admittedReceiptPayloadBrand]: 'AdmittedReceiptPayload';
};

export interface NormalizedExecutionReceipt {
  receipt: ReceiptWithImageId;
  rawPayload: AdmittedReceiptPayload;
}

export function admitReceiptPayload(payload: unknown): AdmittedReceiptPayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Receipt payload must be an object');
  }
  return payload as AdmittedReceiptPayload;
}

/**
 * Normalize zkVM receipt payloads into a stable seal/journal format.
 */
export function normalizeExecutionReceipt(
  executionReceipt: { imageId?: string; payload?: unknown } | undefined,
  fallbackImageId: string,
): NormalizedExecutionReceipt {
  if (!executionReceipt) throw new Error('zkVM execution did not return a modern receipt payload');
  const payload = readExecutionPayload(executionReceipt.payload);
  const isFakeReceipt = isFakeReceiptPayload(payload);

  const modern = extractModernProof(payload);
  const composite = modern ? undefined : extractCompositeProof(payload);

  const seal = resolveNormalizedSeal(payload, modern, composite, isFakeReceipt);
  const journal = resolveNormalizedJournal(payload, modern, composite, isFakeReceipt);

  if (!seal) {
    throw new Error('Receipt seal is missing or invalid (tried direct, modern, and composite formats)');
  }

  if (!journal) {
    throw new Error('Receipt journal is missing or invalid (tried direct, modern, and composite formats)');
  }

  const imageId =
    (typeof executionReceipt.imageId === 'string' ? executionReceipt.imageId : undefined) ?? fallbackImageId;

  const metadata = projectReceiptMetadata(payload, isFakeReceipt);

  return {
    receipt: {
      seal,
      journal,
      imageId,
      ...omitUndefinedProperties({ metadata: metadata }),
    },
    rawPayload: admitReceiptPayload(payload),
  };
}

function readExecutionPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('zkVM execution did not return a modern receipt payload');
  return value as Record<string, unknown>;
}

function resolveNormalizedSeal(
  payload: Record<string, unknown>,
  modern: ReceiptFormat | undefined,
  composite: ReceiptFormat | undefined,
  isFakeReceipt: boolean,
): string | undefined {
  const seal = extractSealBase64(payload['seal']) ?? modern?.sealBase64 ?? composite?.sealBase64;
  return !seal && isFakeReceipt ? Buffer.from('dev-mode-fake-receipt').toString('base64') : seal;
}

function resolveNormalizedJournal(
  payload: Record<string, unknown>,
  modern: ReceiptFormat | undefined,
  composite: ReceiptFormat | undefined,
  isFakeReceipt: boolean,
): string | undefined {
  const journal = extractJournalBase64(payload['journal']) ?? modern?.journalBase64 ?? composite?.journalBase64;
  return !journal && isFakeReceipt ? fakeJournalBase64(payload) : journal;
}

function fakeJournalBase64(payload: Record<string, unknown>): string {
  const fallback =
    typeof payload['journal'] === 'object' && payload['journal'] !== null ? payload['journal'] : { fake: true };
  return Buffer.from(JSON.stringify(fallback)).toString('base64');
}

function projectReceiptMetadata(payload: Record<string, unknown>, isFakeReceipt: boolean) {
  return isFakeReceipt && typeof payload['metadata'] === 'object' && payload['metadata'] !== null
    ? { ...(payload['metadata'] as Record<string, unknown>), isFake: true }
    : isFakeReceipt
      ? { isFake: true }
      : undefined;
}

function isFakeReceiptPayload(payload: Record<string, unknown>): boolean {
  const inner = payload['inner'];
  if (!inner || typeof inner !== 'object') {
    return false;
  }
  return 'Fake' in (inner as Record<string, unknown>);
}

function extractSealBase64(sealValue: unknown): string | undefined {
  if (!sealValue) {
    return undefined;
  }

  if (typeof sealValue === 'string') {
    return sealValue;
  }

  if (Array.isArray(sealValue)) {
    return encodeBytesToBase64(sealValue);
  }

  return undefined;
}

type ReceiptFormat = {
  sealBase64: string;
  journalBase64?: string;
  receiptKind?: string;
};

function encodeBytesToBase64(values: unknown[]): string {
  const bytes = new Uint8Array(values.length);
  for (const [index, value] of values.entries()) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('Receipt bytes contain non-numeric value');
    }
    if (value < 0 || value > 255 || !Number.isInteger(value)) {
      throw new Error('Receipt bytes must be integers between 0 and 255');
    }
    bytes[index] = value;
  }
  return Buffer.from(bytes).toString('base64');
}

function extractJournalBase64(journalValue: unknown): string | undefined {
  if (!journalValue) {
    return undefined;
  }

  if (typeof journalValue === 'string') {
    return journalValue;
  }

  if (typeof journalValue === 'object') {
    const record = journalValue as Record<string, unknown>;
    if (Array.isArray(record['bytes'])) {
      return encodeBytesToBase64(record['bytes']);
    }
    return Buffer.from(JSON.stringify(record)).toString('base64');
  }

  return undefined;
}

function firstReceiptString(record: Record<string, unknown>, first: string, second: string): string | undefined {
  return typeof record[first] === 'string'
    ? record[first]
    : typeof record[second] === 'string'
      ? record[second]
      : undefined;
}

function extractModernProof(payload: Record<string, unknown>): ReceiptFormat | undefined {
  const modernCandidate = payload['modernReceipt'] ?? payload['modern_receipt'];
  if (!modernCandidate || typeof modernCandidate !== 'object') {
    return undefined;
  }

  const modern = modernCandidate as Record<string, unknown>;
  const seal = firstReceiptString(modern, 'seal', 'seal_base64');
  if (!seal) {
    return undefined;
  }

  const journal = firstReceiptString(modern, 'journal', 'journal_base64');

  const receiptKind = typeof modern['kind'] === 'string' ? modern['kind'] : undefined;

  return {
    sealBase64: seal,
    ...omitUndefinedProperties({ journalBase64: journal, receiptKind }),
  };
}

function extractCompositeProof(payload: Record<string, unknown>): ReceiptFormat | undefined {
  const inner = payload['inner'] as Record<string, unknown> | undefined;
  const composite = inner && typeof inner === 'object' ? inner['Composite'] : undefined;
  if (!composite || typeof composite !== 'object') {
    return undefined;
  }

  const segments = (composite as Record<string, unknown>)['segments'];
  if (!Array.isArray(segments) || segments.length === 0) {
    return undefined;
  }

  const segment = segments[0] as Record<string, unknown>;
  const sealValues = segment['seal'];
  if (!Array.isArray(sealValues)) {
    return undefined;
  }

  const sealBase64 = encodeSealWordsToBase64(sealValues);

  const journalBase64 = extractCompositeJournal(payload);

  return { sealBase64, ...omitUndefinedProperties({ journalBase64 }), receiptKind: 'composite' };
}

function extractCompositeJournal(payload: Record<string, unknown>): string | undefined {
  let journalBase64: string | undefined;
  const journal = payload['journal'] as Record<string, unknown> | undefined;
  if (journal && typeof journal === 'object' && Array.isArray(journal['bytes'])) {
    journalBase64 = encodeBytesToBase64(journal['bytes']);
  }

  return journalBase64;
}

function encodeSealWordsToBase64(values: unknown[]): string {
  const flattened = flattenNumericArray(values);
  const buffer = new ArrayBuffer(flattened.length * 4);
  const view = new DataView(buffer);

  flattened.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      throw new Error('Receipt seal contains non-numeric value');
    }
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error('Receipt seal words must be integers between 0 and 4294967295');
    }
    view.setUint32(index * 4, value, true);
  });

  return Buffer.from(new Uint8Array(buffer)).toString('base64');
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function flattenNumericArray(source: unknown[]): number[] {
  const result: number[] = [];
  const stack: unknown[] = [...source];

  while (stack.length > 0) {
    const value = stack.pop();
    if (isUnknownArray(value)) {
      stack.push(...value);
    } else if (typeof value === 'number') {
      result.push(value);
    } else {
      throw new Error('Receipt seal contains unsupported value');
    }
  }

  return result.reverse();
}
