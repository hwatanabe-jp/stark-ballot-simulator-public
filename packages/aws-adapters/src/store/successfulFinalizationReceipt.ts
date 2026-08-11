import { createHash } from 'node:crypto';
import type { SuccessfulFinalizationReceipt } from '@stark-ballot/application/finalize/successful-finalization-commit-admission';

export function computeSuccessfulFinalizationReceiptHash(receipt: SuccessfulFinalizationReceipt): string {
  const hash = createHash('sha256');
  hash.update(receipt.receipt);
  hash.update(receipt.timestamp.toString());
  return `0x${hash.digest('hex')}`;
}
