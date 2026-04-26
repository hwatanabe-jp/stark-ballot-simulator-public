/**
 * /api/bitmap-proof endpoint
 * Following final_design.md §2.6.1 specifications
 *
 * Returns Merkle proof materials for individual vote verification
 * Server provides only raw materials, client performs bit extraction
 */

import { generateBitmapMerkleProof } from '@/lib/merkle/bitmap-merkle-tree';
import type {
  BitmapKind,
  BitmapProofResponse,
  BitmapProofError,
  BitmapProofErrorCode,
} from '@/lib/types/api/bitmap-proof';
import { createHash } from 'crypto';
import type { ApiContext } from '@/server/api/context';
import { validateSessionWithCapability } from '@/server/api/middleware/session';
import { matchesIfNoneMatch } from '@/server/http/etag';
import { jsonResponse } from '@/server/http/response';
import { logger } from '@/lib/utils/logger';
import {
  buildUnsupportedFinalizedArtifactResponse,
  resolveSupportedFinalizedRead,
} from '@/server/api/utils/currentArtifactAdmission';

// Cache configuration
const CACHE_MAX_AGE = 86400; // 24 hours (bitmap is immutable after finalization)
const CACHE_STALE_WHILE_REVALIDATE = 3600; // 1 hour

/**
 * Validate index parameter
 * Must be a non-negative integer
 */
function validateIndex(indexStr: string | null): number | null {
  if (!indexStr) {
    return null;
  }

  // Check for malicious inputs
  if (indexStr.includes('..') || indexStr.includes('/') || indexStr.includes('\\')) {
    return null;
  }

  const index = Number(indexStr);

  // Check for valid non-negative integer
  if (!Number.isInteger(index) || index < 0 || !Number.isFinite(index)) {
    return null;
  }

  // Prevent extremely large values
  if (index > Number.MAX_SAFE_INTEGER) {
    return null;
  }

  return index;
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
function errorResponse(code: BitmapProofErrorCode, message: string, status: number): Response {
  const error: BitmapProofError = {
    error: message,
    code,
  };

  return jsonResponse(error, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store', // Don't cache errors
    },
  });
}

/**
 * GET /api/bitmap-proof
 *
 * Returns Merkle proof for a specific bit in the requested bitmap
 *
 * Query parameters:
 * - i: The bit index to get proof for (0-based)
 * - kind: included | seen (default: included)
 *
 * Response:
 * - leafChunk: 32-byte chunk containing the bit
 * - auditPath: Merkle proof path to root
 *
 * Privacy warning:
 * The 32-byte chunk reveals inclusion status of up to 255 neighboring votes.
 * This is acceptable for PoC with bot votes, but requires user consent in production.
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

    // Extract and validate index parameter
    const { searchParams } = new URL(request.url);
    const indexParam = searchParams.get('i');
    const kind = validateBitmapKind(searchParams.get('kind'));
    const index = validateIndex(indexParam);

    if (index === null) {
      return errorResponse('INVALID_INDEX', 'Invalid or missing index parameter', 400);
    }
    if (kind === null) {
      return errorResponse('INVALID_BITMAP_KIND', 'Invalid bitmap kind parameter', 400);
    }

    // Retrieve session-scoped bitmap data
    const bitmapData = store.getBitmapData ? await store.getBitmapData(sessionResult.sessionId) : null;

    if (!bitmapData) {
      return errorResponse('BITMAP_NOT_FOUND', 'Bitmap data not found. Ensure finalization has completed.', 404);
    }

    // Validate index is within range
    if (index >= bitmapData.treeSize) {
      return errorResponse('INVALID_INDEX', `Index ${index} is out of range (0-${bitmapData.treeSize - 1})`, 400);
    }

    const bitmap = kind === 'seen' ? (bitmapData.seenBitmap ?? null) : bitmapData.includedBitmap;
    if (!bitmap) {
      return errorResponse('BITMAP_NOT_FOUND', `Bitmap data not found for kind '${kind}'.`, 404);
    }

    // Generate Merkle proof
    const proof = generateBitmapMerkleProof(bitmap, index);

    // Build response (server provides only materials, no bit calculation)
    const responseData: BitmapProofResponse = {
      leafChunk: proof.leafChunk,
      auditPath: proof.auditPath,
    };

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
    if (process.env.NODE_ENV === 'development') {
      const duration = performance.now() - startTime;
      logger.debug(`[API] Bitmap proof generated in ${duration.toFixed(2)}ms`, {
        index,
        kind,
        leafIndex: proof.leafIndex,
        pathLength: proof.auditPath.length,
        responseSize: JSON.stringify(responseData).length,
      });
    }

    // Return proof with aggressive caching (data is immutable)
    return jsonResponse(responseData, {
      headers: getCacheHeaders(etag),
    });
  } catch (error) {
    if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
      logger.error('[API] Error generating bitmap proof:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        duration: performance.now() - startTime,
      });
    }

    return errorResponse('INTERNAL_ERROR', 'Failed to generate bitmap proof', 500);
  }
}

// Disable body parsing for GET requests
export const dynamic = 'force-dynamic';
