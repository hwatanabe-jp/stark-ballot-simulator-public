/**
 * /api/bitmap-proof endpoint
 * Following final-design.md §2.6.1 specifications
 *
 * Returns Merkle proof materials for individual vote verification
 * Server provides only raw materials, client performs bit extraction
 */

import { generateBitmapMerkleProof } from '@stark-ballot/verification/merkle/bitmap-merkle-tree';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import type { BitmapKind, BitmapProofResponse } from '@stark-ballot/api-contract/types/api/bitmap-proof';
import { createHash } from 'crypto';
import type { ApiContext } from '../context';
import { validateSessionWithCapability } from '../middleware/session';
import { matchesIfNoneMatch } from '../../http/etag';
import { errorResponse } from '../../http/response';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { logger } from '@stark-ballot/diagnostics/logger';
import { BitmapProofResponseSchema } from '@stark-ballot/api-contract/validation/apiSchemas';
import { respondWithSchema } from '../utils/responseSchema';
import {
  buildUnsupportedFinalizedArtifactResponse,
  resolveSupportedFinalizedRead,
} from '../utils/currentArtifactAdmission';
import { normalizeHexString } from '@stark-ballot/verification/shared/hex';
import { asBitmapBitIndex, type BitmapBitIndex } from '@stark-ballot/verification/bitmap-proof-types';

// Cache configuration
const CACHE_MAX_AGE = 86400; // 24 hours (bitmap is immutable after finalization)
const CACHE_STALE_WHILE_REVALIDATE = 3600; // 1 hour

export interface BitmapProofData {
  includedBitmap: boolean[];
  includedBitmapRoot: string;
  seenBitmap?: boolean[];
  seenBitmapRoot?: string;
  treeSize: number;
}

export interface BitmapProofFinalizationResult {
  journal: {
    includedBitmapRoot?: string;
    seenBitmapRoot?: string;
    treeSize: number;
  };
}

export type BitmapProofResolution = { ok: true; response: BitmapProofResponse } | { ok: false; message: string };

/**
 * Validate index parameter
 * Must be a non-negative integer
 */
function validateIndex(indexStr: string | null): BitmapBitIndex | null {
  if (!indexStr) {
    return null;
  }

  if (!/^(0|[1-9][0-9]*)$/.test(indexStr)) {
    return null;
  }

  const index = Number(indexStr);
  try {
    return asBitmapBitIndex(index);
  } catch {
    return null;
  }
}

function validateBitmapKind(kindStr: string | null): BitmapKind | null {
  if (!kindStr || kindStr === 'included') {
    return 'included';
  }

  if (kindStr === 'seen') {
    return 'seen';
  }

  return null;
}

/**
 * Generate ETag for proof data
 */
function generateETag(data: BitmapProofResponse): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(data));
  return `W/"${hash.digest('hex').substring(0, 16)}"`;
}

/**
 * Create cache headers for bitmap proof
 * Bitmap data is immutable after finalization, so can be cached aggressively
 */
function getCacheHeaders(etag: string): HeadersInit {
  return {
    ETag: etag,
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': `private, max-age=${CACHE_MAX_AGE}, stale-while-revalidate=${CACHE_STALE_WHILE_REVALIDATE}, immutable`,
    Vary: 'X-Session-ID, X-Session-Capability',
  };
}

/**
 * Create error response
 */
function bitmapProofErrorResponse(message: string): Response {
  return errorResponse(ErrorCode.INVALID_BITMAP_PROOF_REQUEST, { details: message });
}

function hasMatchingBitmapRoot(params: {
  bitmap: boolean[];
  storedRoot: string | undefined;
  journalRoot: string | undefined;
  treeSize: number;
  journalTreeSize: number;
}): boolean {
  if (!params.storedRoot || !params.journalRoot) {
    return false;
  }
  if (params.treeSize !== params.journalTreeSize || params.bitmap.length !== params.treeSize) {
    return false;
  }

  const computedRoot = computeIncludedBitmapRoot(params.bitmap);
  const normalizedComputed = normalizeHexString(computedRoot);
  return (
    normalizedComputed === normalizeHexString(params.storedRoot) &&
    normalizedComputed === normalizeHexString(params.journalRoot)
  );
}

export function resolveBitmapProofResponse(params: {
  bitmapData: BitmapProofData;
  finalizationResult: BitmapProofFinalizationResult;
  index: BitmapBitIndex;
  kind: BitmapKind;
}): BitmapProofResolution {
  const { bitmapData, finalizationResult, index, kind } = params;
  if (index >= bitmapData.treeSize) {
    return { ok: false, message: `Index ${index} is out of range (0-${bitmapData.treeSize - 1})` };
  }

  const bitmap = kind === 'seen' ? (bitmapData.seenBitmap ?? null) : bitmapData.includedBitmap;
  if (!Array.isArray(bitmap)) {
    return { ok: false, message: `Bitmap data not found for kind '${kind}'.` };
  }
  const storedRoot = kind === 'seen' ? bitmapData.seenBitmapRoot : bitmapData.includedBitmapRoot;
  const journalRoot =
    kind === 'seen' ? finalizationResult.journal.seenBitmapRoot : finalizationResult.journal.includedBitmapRoot;
  if (
    !hasMatchingBitmapRoot({
      bitmap,
      storedRoot,
      journalRoot,
      treeSize: bitmapData.treeSize,
      journalTreeSize: finalizationResult.journal.treeSize,
    })
  ) {
    return { ok: false, message: `Bitmap root mismatch for kind '${kind}'.` };
  }

  const proof = generateBitmapMerkleProof(bitmap, index);
  return {
    ok: true,
    response: {
      leafChunk: proof.leafChunk,
      auditPath: proof.auditPath,
    },
  };
}

/**
 * GET /api/bitmap-proof
 *
 * Returns Merkle proof for a specific bit in the requested bitmap
 *
 * Query parameters:
 * - i: The session user's vote index (0-based)
 * - kind: included | seen (default: included)
 *
 * Response:
 * - leafChunk: 32-byte chunk containing the bit
 * - auditPath: Merkle proof path to root
 *
 * Privacy warning:
 * The 32-byte chunk reveals inclusion status of up to 255 neighboring votes.
 * Normal API usage is therefore limited to the session user's vote index.
 */
/**
 * Return bitmap Merkle proof materials for a specific bit.
 */
export async function getBitmapProofHandler({ request, store }: ApiContext): Promise<Response> {
  const startTime = performance.now();

  try {
    const sessionResult = await validateSessionWithCapability(request.headers, store, { updateActivity: false });
    if (sessionResult instanceof Response) {
      return sessionResult;
    }
    const finalizedRead = resolveSupportedFinalizedRead(sessionResult.session);
    if (finalizedRead.artifactState) {
      return buildUnsupportedFinalizedArtifactResponse(finalizedRead.artifactState);
    }
    if (!finalizedRead.finalizationResult) {
      return bitmapProofErrorResponse('Bitmap proof is unavailable until finalization has completed.');
    }

    // Extract and validate index parameter
    const { searchParams } = new URL(request.url);
    const indexParam = searchParams.get('i');
    const kind = validateBitmapKind(searchParams.get('kind'));
    const index = validateIndex(indexParam);

    if (index === null) {
      return bitmapProofErrorResponse('Invalid or missing index parameter');
    }
    if (kind === null) {
      return bitmapProofErrorResponse('Invalid bitmap kind parameter');
    }
    if (sessionResult.session.userVoteIndex === undefined) {
      return errorResponse(ErrorCode.USER_NOT_VOTED);
    }
    if (index !== sessionResult.session.userVoteIndex) {
      return bitmapProofErrorResponse('Bitmap proof requests are limited to the session user vote.');
    }

    // Retrieve session-scoped bitmap data
    const bitmapData = store.getBitmapData ? await store.getBitmapData(sessionResult.sessionId) : null;

    if (!bitmapData) {
      return bitmapProofErrorResponse('Bitmap data not found. Ensure finalization has completed.');
    }

    const proofResolution = resolveBitmapProofResponse({
      bitmapData,
      finalizationResult: finalizedRead.finalizationResult,
      index,
      kind,
    });
    if (!proofResolution.ok) {
      return bitmapProofErrorResponse(proofResolution.message);
    }
    const responseData = proofResolution.response;

    // Generate ETag for caching
    const etag = generateETag(responseData);

    // Check for conditional request
    const clientETag = request.headers.get('If-None-Match');
    if (matchesIfNoneMatch(clientETag, etag)) {
      // Return 304 Not Modified
      return new Response(null, {
        status: 304,
        headers: getCacheHeaders(etag),
      });
    }

    // Log performance in development
    if (process.env['NODE_ENV'] === 'development') {
      const duration = performance.now() - startTime;
      logger.debug(`[API] Bitmap proof generated in ${duration.toFixed(2)}ms`, {
        index,
        kind,
        leafIndex: Math.floor(index / 256),
        pathLength: responseData.auditPath.length,
        responseSize: JSON.stringify(responseData).length,
      });
    }

    // Return proof with aggressive caching (data is immutable)
    return respondWithSchema(BitmapProofResponseSchema, responseData, {
      headers: getCacheHeaders(etag),
    });
  } catch (error) {
    if (process.env['NODE_ENV'] !== 'test' && process.env['VITEST'] !== 'true') {
      logger.error('[API] Error generating bitmap proof:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        duration: performance.now() - startTime,
      });
    }

    return errorResponse(ErrorCode.INTERNAL_ERROR, { details: 'Failed to generate bitmap proof' });
  }
}

// Disable body parsing for GET requests
export const dynamic = 'force-dynamic';
