import { Buffer } from 'buffer';
import type { ReceiptWithImageId } from '@/lib/verification/image-id-types';

/**
 * Normalize zkVM receipt payloads into a stable seal/journal format.
 */
export function normalizeExecutionReceipt(
  executionReceipt: { imageId?: string; payload?: unknown } | undefined,
  fallbackImageId: string,
): { receipt: ReceiptWithImageId; rawPayload: Record<string, unknown> } {
  if (!executionReceipt || !executionReceipt.payload || typeof executionReceipt.payload !== 'object') {
    throw new Error('zkVM execution did not return a modern receipt payload');
  }

  const payload = executionReceipt.payload as Record<string, unknown>;
  const isFakeReceipt = isFakeReceiptPayload(payload);

  const modern = extractModernProof(payload);
  const composite = modern ? undefined : extractCompositeProof(payload);

  let seal = extractSealBase64(payload.seal) ?? modern?.sealBase64 ?? composite?.sealBase64;
  let journal = extractJournalBase64(payload.journal) ?? modern?.journalBase64 ?? composite?.journalBase64;

  if (!seal && isFakeReceipt) {
    seal = Buffer.from('dev-mode-fake-receipt').toString('base64');
  }

  if (!journal && isFakeReceipt) {
    const fallback = typeof payload.journal === 'object' && payload.journal !== null ? payload.journal : { fake: true };
    journal = Buffer.from(JSON.stringify(fallback)).toString('base64');
  }

  if (!seal) {
    throw new Error('Receipt seal is missing or invalid (tried direct, modern, and composite formats)');
  }

  if (!journal) {
    throw new Error('Receipt journal is missing or invalid (tried direct, modern, and composite formats)');
  }

  const imageId =
    (typeof executionReceipt.imageId === 'string' ? executionReceipt.imageId : undefined) ?? fallbackImageId;

  const metadata =
    isFakeReceipt && typeof payload.metadata === 'object' && payload.metadata !== null
      ? { ...(payload.metadata as Record<string, unknown>), isFake: true }
      : isFakeReceipt
        ? { isFake: true }
        : undefined;

  return {
    receipt: {
      seal,
      journal,
      imageId,
      metadata,
    },
    rawPayload: payload,
  };
}

function isFakeReceiptPayload(payload: Record<string, unknown>): boolean {
  const inner = payload.inner;
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
    return Buffer.from(sealValue as number[]).toString('base64');
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
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      throw new Error('Receipt bytes contain non-numeric value');
    }
    const numeric = Number(value);
    if (numeric < 0 || numeric > 255 || !Number.isInteger(numeric)) {
      throw new Error('Receipt bytes must be integers between 0 and 255');
    }
    bytes[index] = numeric;
  });
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
    if (Array.isArray(record.bytes)) {
      return encodeBytesToBase64(record.bytes);
    }
    return Buffer.from(JSON.stringify(record)).toString('base64');
  }

  return undefined;
}

function extractModernProof(payload: Record<string, unknown>): ReceiptFormat | undefined {
  const modernCandidate = payload.modernReceipt ?? payload.modern_receipt;
  if (!modernCandidate || typeof modernCandidate !== 'object') {
    return undefined;
  }

  const modern = modernCandidate as Record<string, unknown>;
  const seal =
    typeof modern.seal === 'string'
      ? modern.seal
      : typeof modern.seal_base64 === 'string'
        ? modern.seal_base64
        : undefined;
  if (!seal) {
    return undefined;
  }

  const journal =
    typeof modern.journal === 'string'
      ? modern.journal
      : typeof modern.journal_base64 === 'string'
        ? modern.journal_base64
        : undefined;

  const receiptKind = typeof modern.kind === 'string' ? modern.kind : undefined;

  return {
    sealBase64: seal,
    journalBase64: journal,
    receiptKind,
  };
}

function extractCompositeProof(payload: Record<string, unknown>): ReceiptFormat | undefined {
  const inner = payload.inner as Record<string, unknown> | undefined;
  const composite = inner && typeof inner === 'object' ? inner.Composite : undefined;
  if (!composite || typeof composite !== 'object') {
    return undefined;
  }

  const segments = (composite as Record<string, unknown>).segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    return undefined;
  }

  const segment = segments[0] as Record<string, unknown>;
  const sealValues = segment.seal;
  if (!Array.isArray(sealValues)) {
    return undefined;
  }

  const sealBase64 = encodeSealWordsToBase64(sealValues);

  let journalBase64: string | undefined;
  const journal = payload.journal as Record<string, unknown> | undefined;
  if (journal && typeof journal === 'object' && Array.isArray(journal.bytes)) {
    journalBase64 = encodeBytesToBase64(journal.bytes);
  }

  return { sealBase64, journalBase64, receiptKind: 'composite' };
}

function encodeSealWordsToBase64(values: unknown[]): string {
  const flattened = flattenNumericArray(values);
  const buffer = new ArrayBuffer(flattened.length * 4);
  const view = new DataView(buffer);

  flattened.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      throw new Error('Receipt seal contains non-numeric value');
    }
    view.setUint32(index * 4, Number(value) >>> 0, true);
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
