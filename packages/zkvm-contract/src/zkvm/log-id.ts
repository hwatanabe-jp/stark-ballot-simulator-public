import { createHash } from 'crypto';
import { asLogId, type LogId } from './identifiers';

export function generateLogId(seed: string): LogId {
  const hash = createHash('sha256');
  hash.update('stark-ballot:bulletin-log|v1.0');
  hash.update(seed);
  return asLogId('0x' + hash.digest('hex'));
}
