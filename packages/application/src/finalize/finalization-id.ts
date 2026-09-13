import { randomBytes } from 'crypto';
import type { FinalizationId } from '@stark-ballot/application/finalize/finalization-types';
import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';

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

function brandFinalizationId(value: string): FinalizationId {
  return value as FinalizationId;
}

export function parseFinalizationId(value: unknown): FinalizationId | undefined {
  return typeof value === 'string' && isSafeVerifierSegment(value) ? brandFinalizationId(value) : undefined;
}

export function asFinalizationId(value: string): FinalizationId {
  const finalizationId = parseFinalizationId(value);
  if (!finalizationId) {
    throw new Error('Invalid finalizationId');
  }
  return finalizationId;
}

/**
 * Generate a sortable application finalization attempt identifier.
 */
export function generateFinalizationId(timestamp = Date.now()): FinalizationId {
  return asFinalizationId(encodeTimeComponent(timestamp, 10) + encodeRandomComponent(16));
}
