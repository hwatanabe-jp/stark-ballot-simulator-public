import { createHash } from 'node:crypto';
import {
  admitSuccessfulFinalizationReceipt,
  type SuccessfulFinalizationReceipt,
} from '@stark-ballot/application/finalize/successful-finalization-commit-admission';

export function computeSuccessfulFinalizationReceiptHash(receipt: SuccessfulFinalizationReceipt): string {
  const hash = createHash('sha256');
  hash.update(receipt.receipt);
  hash.update(receipt.timestamp.toString());
  return `0x${hash.digest('hex')}`;
}

/** Preserve an existing publication identity when retrying the same receipt. */
export function prepareReceiptPublication(
  receipt: SuccessfulFinalizationReceipt | undefined,
  existing: { receiptHash: string; boardIndex: number } | undefined,
  nextBoardIndex: number,
) {
  if (!receipt) return undefined;
  return {
    receiptHash: existing?.receiptHash ?? computeSuccessfulFinalizationReceiptHash(receipt),
    boardIndex: existing?.boardIndex ?? nextBoardIndex,
    timestamp: receipt.timestamp,
  };
}

export function admitPersistedReceiptBody(existing: { receipt: unknown; receiptHash: string } | undefined) {
  let body: SuccessfulFinalizationReceipt | undefined;
  try {
    body = existing ? admitSuccessfulFinalizationReceipt(existing.receipt) : undefined;
  } catch {
    throw new Error('Invalid persisted finalization receipt');
  }
  if (existing && (!body || existing.receiptHash !== computeSuccessfulFinalizationReceiptHash(body))) {
    throw new Error('Invalid persisted finalization receipt');
  }
  return body;
}

export function assertReceiptPublicationCounter(
  existing: { boardIndex: number } | undefined,
  receipt: SuccessfulFinalizationReceipt | undefined,
  nextBoardIndex: number,
): void {
  if (existing && receipt && (!Number.isSafeInteger(nextBoardIndex) || nextBoardIndex <= existing.boardIndex)) {
    throw new Error('Receipt board counter does not cover the persisted publication');
  }
}
