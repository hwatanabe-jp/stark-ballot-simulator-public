import { randomBytes } from 'crypto';

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
    output += CROCKFORD_BASE32[bytes[i] & 31];
  }
  return output;
}

/**
 * Generate a sortable execution identifier using Crockford Base32.
 */
export function generateExecutionId(timestamp = Date.now()): string {
  return encodeTimeComponent(timestamp, 10) + encodeRandomComponent(16);
}
