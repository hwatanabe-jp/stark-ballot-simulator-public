import { randomBytes } from 'crypto';
import type { FinalizationExecutionId } from '@stark-ballot/application/finalize/finalization-types';

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTimeComponent(time: number, length: number): string {
  let value = Math.floor(time);
  let output = '';
  for (let i = 0; i < length; i++) {
    output = CROCKFORD_BASE32[value % 32] + output;
    value = Math.floor(value / 32);
  }
  return output;
}

function encodeRandomComponent(length: number): string {
  const bytes = randomBytes(length);
  let output = '';
  for (let i = 0; i < length; i++) {
    const byte = bytes[i] ?? 0;
    output += CROCKFORD_BASE32[byte & 31] ?? '0';
  }
  return output;
}

/**
 * Generate a sortable application finalization attempt identifier.
 */
export function generateExecutionId(timestamp = Date.now()): FinalizationExecutionId {
  return encodeTimeComponent(timestamp, 10) + encodeRandomComponent(16);
}
