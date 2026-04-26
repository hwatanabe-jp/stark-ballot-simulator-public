import { createHash } from 'crypto';

export function generateLogId(seed: string): string {
  const hash = createHash('sha256');
  hash.update('stark-ballot:bulletin-log|v1.0');
  hash.update(seed);
  return '0x' + hash.digest('hex');
}
