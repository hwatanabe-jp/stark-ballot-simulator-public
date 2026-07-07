export type BitmapKind = 'included' | 'seen';

declare const bitmapProofBrand: unique symbol;

export type BitmapProofIdentifier<Name extends string> = number & {
  readonly [bitmapProofBrand]: Name;
};

export type BitmapBitIndex = BitmapProofIdentifier<'BitmapBitIndex'>;
export type AuthenticatedBitmapTreeSize = BitmapProofIdentifier<'AuthenticatedBitmapTreeSize'>;
export type BitmapLeafIndex = BitmapProofIdentifier<'BitmapLeafIndex'>;
export type BitmapBitOffset = BitmapProofIdentifier<'BitmapBitOffset'>;
export type BitmapRoot = string & {
  readonly [bitmapProofBrand]: 'BitmapRoot';
};

function brandNumber<Name extends string>(value: number): BitmapProofIdentifier<Name> {
  return value as BitmapProofIdentifier<Name>;
}

export function asBitmapBitIndex(value: number): BitmapBitIndex {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('bitmap bit index must be a non-negative safe integer');
  }
  return brandNumber<'BitmapBitIndex'>(value);
}

export function asAuthenticatedBitmapTreeSize(value: number): AuthenticatedBitmapTreeSize {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('authenticated bitmap tree size must be a positive safe integer');
  }
  return brandNumber<'AuthenticatedBitmapTreeSize'>(value);
}

export function asBitmapLeafIndex(value: number): BitmapLeafIndex {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('bitmap leaf index must be a non-negative safe integer');
  }
  return brandNumber<'BitmapLeafIndex'>(value);
}

export function asBitmapBitOffset(value: number): BitmapBitOffset {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 256) {
    throw new Error('bitmap bit offset must be a safe integer in [0, 255]');
  }
  return brandNumber<'BitmapBitOffset'>(value);
}

export function asBitmapRoot(value: string): BitmapRoot {
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('bitmap root must be a 32-byte hex string');
  }
  return value as BitmapRoot;
}

export interface AuthenticatedBitmapProofContext {
  bitIndex: BitmapBitIndex;
  treeSize: AuthenticatedBitmapTreeSize;
  expectedRoot: BitmapRoot;
}

export interface BitmapProofResponse {
  leafChunk: string;
  auditPath: Array<{
    hash: string;
    position: 'left' | 'right';
  }>;
}

export interface BitmapVerificationResult {
  valid: boolean;
  included: boolean;
  leafIndex: number;
  bitOffset: number;
}
