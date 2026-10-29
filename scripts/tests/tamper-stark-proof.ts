#!/usr/bin/env tsx
/**
 * STARK Proof Tamper Script
 *
 * Generates a tampered version of a valid STARK receipt to test
 * the verifier's ability to detect proof manipulation.
 *
 * This demonstrates that RISC Zero STARK proofs are tamper-evident:
 * even a single-bit change will cause verification to fail.
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'node:url';
import { isNumberArray, isNonNullObject } from '@stark-ballot/validation/unknown-value-guards';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const VALID_RECEIPT = join(scriptDirectory, '../../zkvm/test-data/test-fixture-valid-receipt.json');
const TAMPERED_RECEIPT = join(scriptDirectory, '../../zkvm/test-data/test-fixture-tampered-stark-receipt.json');

const TamperType = {
  SINGLE_BIT_FLIP: 'SINGLE_BIT_FLIP', // Flip 1 bit (minimal change)
  SINGLE_VALUE_CHANGE: 'SINGLE_VALUE_CHANGE', // Change 1 array element
  MULTIPLE_VALUES: 'MULTIPLE_VALUES', // Change multiple elements
  ZERO_OUT_RANGE: 'ZERO_OUT_RANGE', // Zero out a range
} as const;

type TamperType = (typeof TamperType)[keyof typeof TamperType];

interface Receipt {
  receipt: {
    inner: {
      Composite: {
        segments: Array<{
          seal: number[];
          [key: string]: unknown;
        }>;
        [key: string]: unknown;
      };
    };
  };
  [key: string]: unknown;
}

function flipSealBit(seal: number[]): string {
  // Flip the least significant bit of seal[1000]
  const original = seal[1000];
  seal[1000] = strictDefined(seal[1000]) ^ 1;
  return `Flipped bit in seal[1000]: ${original} → ${seal[1000]}`;
}

function changeSealValue(seal: number[]): string {
  // Change seal[5000] to a completely different value
  const before = seal[5000];
  seal[5000] = (strictDefined(seal[5000]) + 12345) & 0xffffffff;
  return `Changed seal[5000]: ${before} → ${seal[5000]}`;
}

function changeMultipleSealValues(seal: number[]): string {
  // Change values at multiple positions
  const changes: string[] = [];
  [1000, 10000, 30000].forEach((index) => {
    const oldVal = seal[index];
    seal[index] = (strictDefined(seal[index]) + 1) & 0xffffffff;
    changes.push(`seal[${index}]: ${oldVal} → ${seal[index]}`);
  });
  return `Changed 3 positions:\n    ${changes.join('\n    ')}`;
}

function zeroSealRange(seal: number[]): string {
  // Zero out 100 consecutive elements
  let nonZeroCount = 0;
  for (let i = 20000; i < 20100; i++) {
    if (seal[i] !== 0) nonZeroCount++;
    seal[i] = 0;
  }
  return `Zeroed seal[20000:20100] (${nonZeroCount} non-zero values → 0)`;
}

const SEAL_TAMPERS = new Map<TamperType, (seal: number[]) => string>([
  [TamperType.SINGLE_BIT_FLIP, flipSealBit],
  [TamperType.SINGLE_VALUE_CHANGE, changeSealValue],
  [TamperType.MULTIPLE_VALUES, changeMultipleSealValues],
  [TamperType.ZERO_OUT_RANGE, zeroSealRange],
]);
function applySealTamper(type: TamperType, seal: number[]): string {
  const operation = SEAL_TAMPERS.get(type);
  if (!operation) throw new Error('Unknown tamper type');
  return operation(seal);
}

function tamperReceipt(type: TamperType): void {
  console.log('STARK Proof Tamper Tool\n');
  console.log(`Reading valid receipt from: ${VALID_RECEIPT}`);

  const receiptData: unknown = JSON.parse(readFileSync(VALID_RECEIPT, 'utf-8'));
  if (!isReceipt(receiptData)) {
    throw new Error(
      [
        'Expected a real receipt with receipt.inner.Composite.segments[0].seal.',
        'The current file looks like a dev-mode/fake receipt or stale artifact.',
        'Regenerate it with: ./zkvm/target/release/host zkvm/test-data/test-fixture-valid.json',
      ].join(' '),
    );
  }
  const receipt = receiptData;
  const seal = strictDefined(receipt.receipt.inner.Composite.segments[0]).seal;

  const originalLength = seal.length;
  console.log(`  Seal array length: ${originalLength.toLocaleString()} elements`);
  console.log(`  Tamper type: ${type}\n`);

  const changeDescription = applySealTamper(type, seal);

  console.log(`Applied tampering:`);
  console.log(`  ${changeDescription}\n`);

  writeFileSync(TAMPERED_RECEIPT, JSON.stringify(receipt, null, 2));
  console.log(`Generated tampered receipt:`);
  console.log(`  ${TAMPERED_RECEIPT}\n`);
  console.log(`WARNING: This receipt should FAIL verification!`);
  console.log(`   Even a 1-bit change breaks STARK proof integrity.\n`);
}

function hasCompositeSeal(inner: unknown): boolean {
  if (!isNonNullObject(inner)) {
    return false;
  }
  const composite = inner['Composite'];
  if (!isNonNullObject(composite)) {
    return false;
  }
  const segments = composite['segments'];
  if (!Array.isArray(segments)) {
    return false;
  }
  return segments.every((segment) => isNonNullObject(segment) && isNumberArray(segment['seal']));
}

function isReceipt(value: unknown): value is Receipt {
  if (!isNonNullObject(value)) {
    return false;
  }
  const receipt = value['receipt'];
  if (!isNonNullObject(receipt)) {
    return false;
  }
  return hasCompositeSeal(receipt['inner']);
}

// Parse command line arguments
const args = process.argv.slice(2);
const tamperTypeArg = args[0]?.toUpperCase();
const tamperTypeValues: Record<TamperType, true> = {
  [TamperType.SINGLE_BIT_FLIP]: true,
  [TamperType.SINGLE_VALUE_CHANGE]: true,
  [TamperType.MULTIPLE_VALUES]: true,
  [TamperType.ZERO_OUT_RANGE]: true,
};
const tamperType = isTamperType(tamperTypeArg) ? tamperTypeArg : TamperType.SINGLE_BIT_FLIP;

function isTamperType(value: string | undefined): value is TamperType {
  return typeof value === 'string' && value in tamperTypeValues;
}

// Run tamper operation
tamperReceipt(tamperType);
