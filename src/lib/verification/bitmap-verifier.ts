/**
 * Client-side bitmap verification
 * Following final_design.md §2.6.1 specifications
 *
 * Client independently calculates bit positions to prevent server manipulation
 * Server provides only raw materials (chunk and audit path)
 */

import type { BitmapKind, BitmapProofResponse, BitmapVerificationResult } from '@/lib/types/api/bitmap-proof';
import { getStringProperty, isRecord } from '@/lib/utils/guards';
import { resolveApiUrl } from '@/lib/api/apiBaseUrl';
import { getSessionAuthHeaders, getSessionData } from '@/lib/session';
import { verifyBitmapMerkleProof } from '@/lib/merkle/bitmap-merkle-tree';
import { calculateBitmapBitOffset, calculateBitmapLeafIndex, extractBitFromChunkHex } from '@/lib/zkvm/bitmap';

/**
 * Options for bitmap verification
 */
export interface BitmapVerificationOptions {
  /** Custom API endpoint (default: /api/bitmap-proof) */
  apiEndpoint?: string;
  /**
   * Session ID for fetching proof materials (used by server-side verifier).
   */
  sessionId?: string;
  /**
   * Additional headers to include in fetch request.
   */
  headers?: Record<string, string>;
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
  return extractBitFromChunkHex(chunkHex, bitOffset);
}

/**
 * Verify a bitmap Merkle proof on the client side
 *
 * @param proofResponse - The proof response from the server
 * @param bitIndex - The bit index being verified
 * @param expectedRoot - The expected Merkle root from the receipt
 * @returns Verification result with extracted bit value
 */
export function verifyBitmapProof(
  proofResponse: BitmapProofResponse,
  bitIndex: number,
  expectedRoot: string,
): BitmapVerificationResult {
  return verifyBitmapMerkleProof(proofResponse.leafChunk, proofResponse.auditPath, expectedRoot, bitIndex);
}

/**
 * Verify if my vote was counted by fetching and verifying bitmap proof
 *
 * @param myIndex - My vote index (bulletin index)
 * @param includedBitmapRoot - The bitmap root from the zkVM receipt
 * @param options - Verification options
 * @returns Extended verification result with privacy warning
 */
export async function verifyMyVoteWasCounted(
  myIndex: number,
  includedBitmapRoot: string,
  options: BitmapVerificationOptions = {},
): Promise<ExtendedVerificationResult> {
  const result = await verifyBitmapByKind(myIndex, includedBitmapRoot, 'included', options);

  return {
    ...result,
    privacyNotice:
      '注意: ビットマップ証明を取得すると、同じグループ内（最大255票）の' +
      '他の投票がカウントされたかどうかの情報がすべて漏洩します。' +
      '投票内容（どの選択肢に投票したか）は秘匿されます。',
  };
}

export async function explainVoteInclusionStatus(
  myIndex: number,
  input: {
    includedBitmapRoot: string;
    seenBitmapRoot?: string;
  },
  options: BitmapVerificationOptions = {},
): Promise<ExplainedVoteInclusionResult> {
  const includedResult = await verifyMyVoteWasCounted(myIndex, input.includedBitmapRoot, options);
  if (!includedResult.valid) {
    return {
      ...includedResult,
      statusDetail: 'unknown_excluded',
    };
  }

  if (includedResult.included) {
    return {
      ...includedResult,
      seen: true,
      statusDetail: 'counted',
    };
  }

  if (!input.seenBitmapRoot) {
    return {
      ...includedResult,
      statusDetail: 'unknown_excluded',
    };
  }

  let seenResult: BitmapVerificationResult;
  try {
    seenResult = await verifyBitmapByKind(myIndex, input.seenBitmapRoot, 'seen', options);
  } catch {
    return {
      ...includedResult,
      statusDetail: 'unknown_excluded',
    };
  }
  return {
    ...includedResult,
    valid: includedResult.valid,
    seen: seenResult.valid ? seenResult.included : undefined,
    statusDetail: seenResult.valid
      ? seenResult.included
        ? 'presented_but_invalid'
        : 'not_presented'
      : 'unknown_excluded',
  };
}

async function verifyBitmapByKind(
  myIndex: number,
  expectedRoot: string,
  bitmapKind: BitmapKind,
  options: BitmapVerificationOptions = {},
): Promise<BitmapVerificationResult> {
  const { apiEndpoint = resolveApiUrl('/api/bitmap-proof') } = options;

  // Fetch proof from API
  const separator = apiEndpoint.includes('?') ? '&' : '?';
  const url = `${apiEndpoint}${separator}i=${myIndex}&kind=${bitmapKind}`;

  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.sessionId) {
    headers['X-Session-ID'] = options.sessionId;
    if (typeof window !== 'undefined') {
      const session = getSessionData();
      if (session?.sessionId === options.sessionId) {
        Object.assign(headers, getSessionAuthHeaders(session));
      }
    }
  }

  const response = Object.keys(headers).length > 0 ? await fetch(url, { headers }) : await fetch(url);

  if (!response.ok) {
    const errorPayload: unknown = await response.json();
    const errorCode = getStringProperty(errorPayload, 'error');
    throw new Error(`Failed to fetch bitmap proof: ${errorCode || 'Unknown error'}`);
  }

  const proofPayload: unknown = await response.json();
  if (!isBitmapProofResponse(proofPayload)) {
    throw new Error('Invalid bitmap proof response');
  }
  const proofResponse = proofPayload;

  // Verify the proof
  return verifyBitmapProof(proofResponse, myIndex, expectedRoot);
}

function isBitmapProofResponse(value: unknown): value is BitmapProofResponse {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.leafChunk !== 'string') {
    return false;
  }
  if (!Array.isArray(value.auditPath)) {
    return false;
  }
  return value.auditPath.every((node) => {
    if (!isRecord(node)) {
      return false;
    }
    if (typeof node.hash !== 'string') {
      return false;
    }
    return node.position === 'left' || node.position === 'right';
  });
}
