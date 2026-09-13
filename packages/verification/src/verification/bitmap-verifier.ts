/**
 * Client-side bitmap verification
 * Following final-design.md §2.6.1 specifications
 *
 * Client independently calculates bit positions to prevent server manipulation
 * Server provides only raw materials (chunk and audit path)
 */

import type {
  AuthenticatedBitmapTreeSize,
  BitmapBitOffset,
  BitmapLeafIndex,
  BitmapProofResponse,
  BitmapVerificationResult,
} from './bitmap-proof-types';
import {
  asAuthenticatedBitmapTreeSize,
  asBitmapBitIndex,
  asBitmapBitOffset,
  asBitmapLeafIndex,
} from './bitmap-proof-types';
import {
  buildAuthenticatedBitmapProofContext,
  verifyBitmapMerkleProof,
} from '@stark-ballot/verification/merkle/bitmap-merkle-tree';
import {
  calculateBitmapBitOffset,
  calculateBitmapLeafIndex,
  extractBitFromBitmapChunkHex,
} from '@stark-ballot/zkvm-contract/zkvm/bitmap-core';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

/**
 * Options for bitmap verification
 */
export interface BitmapVerificationOptions {
  /** Proof materials admitted by the runtime boundary. */
  proof: BitmapProofResponse;
  /** Receipt-authenticated logical bitmap length used to bind proof shape. */
  treeSize: AuthenticatedBitmapTreeSize;
}

export interface ExplainedBitmapVerificationOptions {
  includedProof: BitmapProofResponse;
  seenProof?: BitmapProofResponse;
  treeSize: AuthenticatedBitmapTreeSize;
}

/**
 * Extended verification result with privacy notice
 */
export interface ExtendedVerificationResult extends BitmapVerificationResult {
  /** Privacy notice about information disclosure */
  privacyNotice: string;
}

export type VoteInclusionStatus = 'counted' | 'presented_but_invalid' | 'not_presented' | 'unknown_excluded';

export interface ExplainedVoteInclusionResult extends ExtendedVerificationResult {
  seen?: boolean;
  statusDetail: VoteInclusionStatus;
}

/**
 * Calculate leaf index on client side
 * Must match server calculation but done independently
 *
 * @param bitIndex - The bit index (0-based)
 * @returns The leaf index in the Merkle tree
 */
export function calculateLeafIndexClient(bitIndex: number): number {
  return calculateBitmapLeafIndex(bitIndex);
}

/**
 * Calculate bit offset within a leaf on client side
 * LSB-first encoding
 *
 * @param bitIndex - The bit index (0-based)
 * @returns The bit offset within the 256-bit leaf
 */
export function calculateBitOffsetClient(bitIndex: number): number {
  return calculateBitmapBitOffset(bitIndex);
}

/**
 * Extract a bit value from a hex chunk
 *
 * @param chunkHex - The 32-byte chunk as hex string (64 chars)
 * @param bitOffset - The bit position within the chunk (0-255)
 * @returns The bit value (true = 1, false = 0)
 */
export function extractBitFromChunk(chunkHex: string, bitOffset: number): boolean {
  return extractBitFromBitmapChunkHex(chunkHex, bitOffset);
}

/**
 * Verify a bitmap Merkle proof on the client side
 *
 * @param proofResponse - Proof material admitted by the runtime boundary
 * @param bitIndex - The bit index being verified
 * @param expectedRoot - The expected Merkle root from the receipt
 * @returns Verification result with extracted bit value
 */
export function verifyBitmapProof(
  proofResponse: BitmapProofResponse,
  bitIndex: number,
  expectedRoot: string,
  options: Pick<BitmapVerificationOptions, 'treeSize'>,
): BitmapVerificationResult {
  let context;
  try {
    context = buildAuthenticatedBitmapProofContext({
      bitIndex,
      treeSize: options.treeSize,
      expectedRoot,
    });
  } catch {
    return {
      valid: false,
      included: false,
      leafIndex: safeLeafIndexForResult(bitIndex),
      bitOffset: safeBitOffsetForResult(bitIndex),
    };
  }
  return verifyBitmapMerkleProof(proofResponse.leafChunk, proofResponse.auditPath, context);
}

function safeLeafIndexForResult(bitIndex: number): BitmapLeafIndex {
  return asBitmapLeafIndex(calculateLeafIndexClient(Number.isSafeInteger(bitIndex) && bitIndex >= 0 ? bitIndex : 0));
}

function safeBitOffsetForResult(bitIndex: number): BitmapBitOffset {
  return asBitmapBitOffset(calculateBitOffsetClient(Number.isSafeInteger(bitIndex) && bitIndex >= 0 ? bitIndex : 0));
}

/**
 * Verify whether a vote was counted from admitted bitmap proof material
 *
 * @param myIndex - My vote index (bulletin index)
 * @param includedBitmapRoot - The bitmap root from the zkVM receipt
 * @param options - Verification options
 * @returns Extended verification result with privacy warning
 */
export function verifyMyVoteWasCounted(
  myIndex: number,
  includedBitmapRoot: string,
  options: BitmapVerificationOptions,
): ExtendedVerificationResult {
  const result = verifyAdmittedBitmapProof(myIndex, includedBitmapRoot, options.proof, options.treeSize);

  return {
    ...result,
    privacyNotice:
      '注意: ビットマップ証明を取得すると、同じグループ内（最大255票）の' +
      '他の投票がカウントされたかどうかの情報がすべて漏洩します。' +
      '投票内容（どの選択肢に投票したか）は秘匿されます。',
  };
}

export function explainVoteInclusionStatus(
  myIndex: number,
  input: {
    includedBitmapRoot: string;
    seenBitmapRoot?: string;
  },
  options: ExplainedBitmapVerificationOptions,
): ExplainedVoteInclusionResult {
  const includedResult = verifyMyVoteWasCounted(myIndex, input.includedBitmapRoot, {
    proof: options.includedProof,
    treeSize: options.treeSize,
  });
  if (!includedResult.valid) {
    return {
      ...includedResult,
      statusDetail: 'unknown_excluded',
    };
  }

  if (includedResult.included) {
    return {
      ...includedResult,
      ...omitUndefinedProperties({ seen: true }),
      statusDetail: 'counted',
    };
  }

  if (!input.seenBitmapRoot) {
    return {
      ...includedResult,
      statusDetail: 'unknown_excluded',
    };
  }

  if (!options.seenProof) {
    return {
      ...includedResult,
      statusDetail: 'unknown_excluded',
    };
  }
  const seenResult = verifyAdmittedBitmapProof(myIndex, input.seenBitmapRoot, options.seenProof, options.treeSize);
  return {
    ...includedResult,
    valid: includedResult.valid,
    ...omitUndefinedProperties({ seen: seenResult.valid ? seenResult.included : undefined }),
    statusDetail: seenResult.valid
      ? seenResult.included
        ? 'presented_but_invalid'
        : 'not_presented'
      : 'unknown_excluded',
  };
}

function verifyAdmittedBitmapProof(
  myIndex: number,
  expectedRoot: string,
  proof: BitmapProofResponse,
  treeSizeValue: AuthenticatedBitmapTreeSize,
): BitmapVerificationResult {
  const bitIndex = asBitmapBitIndex(myIndex);
  const treeSize = asAuthenticatedBitmapTreeSize(treeSizeValue);

  return verifyBitmapProof(proof, bitIndex, expectedRoot, { treeSize });
}
