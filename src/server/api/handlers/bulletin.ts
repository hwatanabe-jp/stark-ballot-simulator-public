import type { ApiContext } from '@/server/api/context';
import { ErrorCode, type ApiError, type ErrorDetails } from '@/lib/errors/apiErrors';
import { errorResponse, jsonResponse } from '@/server/http/response';
import { toApiErrorPayload } from '@/lib/errors/errorPayload';
import type { ConsistencyProofResponse } from '@/lib/types/api/consistency-proof';
import { validateSessionWithCapability } from '@/server/api/middleware/session';
import type { SessionData } from '@/types/server';
import { BulletinProofResponseSchema, BulletinResponseSchema } from '@/lib/validation/apiSchemas';
import { respondWithSchema } from '@/server/api/utils/responseSchema';
import { getCanonicalBulletinRootHistory, getLatestCanonicalBulletinSnapshot } from '@/lib/store/ctSessionState';
import { normalizeHex } from '@/lib/utils/hex';
import { logger } from '@/lib/utils/logger';
import {
  buildUnsupportedFinalizedArtifactResponse,
  resolveSupportedFinalizedRead,
} from '@/server/api/utils/currentArtifactAdmission';

/**
 * Bulletin Board response structure.
 */
interface BulletinBoardResponse {
  /** All vote commitments in bulletin (leaf index) order. */
  commitments: string[];
  /** Current bulletin board root. */
  bulletinRoot: string;
  /** Total number of votes in the tree. */
  treeSize: number;
  /** Current timestamp. */
  timestamp: number;
  /** Next offset for paging (nullable when no more data). */
  nextOffset?: number | null;
  /** Whether additional commitments are available. */
  hasMore?: boolean;
  /** Optional: History of Merkle root snapshots. */
  rootHistory?: Array<{
    timestamp: number;
    bulletinRoot: string;
    treeSize: number;
    signature?: string;
  }>;
}

// UUID v4 validation regex - compiled once for performance
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_BULLETIN_LIMIT = 1000;
const PRIVATE_NO_STORE_CACHE_CONTROL = 'private, no-store';
const SESSION_AUTH_VARY = 'X-Session-ID, X-Session-Capability';

interface BulletinPagingParams {
  offset: number;
  limit?: number;
  hasPaging: boolean;
}

/**
 * Validate vote ID format with security checks.
 */
function isValidVoteId(voteId: string): boolean {
  // Prevent path traversal attacks
  if (voteId.includes('..') || voteId.includes('/') || voteId.includes('\\')) {
    return false;
  }

  // Allow specific test ID for testing purposes
  if (process.env.NODE_ENV === 'test' && voteId === 'non-existent-id') {
    return true;
  }

  // Strict UUID v4 format validation
  return UUID_V4_REGEX.test(voteId);
}

function createPrivateNoStoreHeaders(headers?: HeadersInit): Headers {
  const merged = new Headers(headers);
  merged.set('Cache-Control', PRIVATE_NO_STORE_CACHE_CONTROL);
  merged.set('Vary', SESSION_AUTH_VARY);
  return merged;
}

function createPrivateNoStoreResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: createPrivateNoStoreHeaders(response.headers),
  });
}

function voteProofErrorResponse(error: ApiError | ErrorCode, details?: ErrorDetails): Response {
  const payload = toApiErrorPayload(error, details);
  return jsonResponse(payload, {
    status: payload.statusCode,
    headers: createPrivateNoStoreHeaders({
      'X-Content-Type-Options': 'nosniff',
    }),
  });
}

function parseBulletinPagingParams(requestUrl: string): BulletinPagingParams | Response {
  const { searchParams } = new URL(requestUrl);
  const offsetParam = searchParams.get('offset');
  const limitParam = searchParams.get('limit');
  const hasPaging = offsetParam !== null || limitParam !== null;

  let offset = 0;
  let limit: number | undefined;

  if (offsetParam !== null) {
    const parsedOffset = Number(offsetParam);
    if (!Number.isFinite(parsedOffset) || !Number.isInteger(parsedOffset)) {
      return errorResponse(ErrorCode.INVALID_OFFSET, {
        field: 'offset',
        reason: 'integer',
        expected: 'integer >= 0',
        actual: offsetParam,
      });
    }
    if (parsedOffset < 0) {
      return errorResponse(ErrorCode.INVALID_OFFSET, {
        field: 'offset',
        reason: 'min',
        expected: 'integer >= 0',
        actual: parsedOffset,
      });
    }
    offset = parsedOffset;
  }

  if (limitParam !== null) {
    const parsedLimit = Number(limitParam);
    if (!Number.isFinite(parsedLimit) || !Number.isInteger(parsedLimit)) {
      return errorResponse(ErrorCode.INVALID_LIMIT, {
        field: 'limit',
        reason: 'integer',
        expected: 'integer > 0',
        actual: limitParam,
      });
    }
    if (parsedLimit <= 0) {
      return errorResponse(ErrorCode.INVALID_LIMIT, {
        field: 'limit',
        reason: 'min',
        expected: 'integer > 0',
        actual: parsedLimit,
      });
    }
    if (parsedLimit > MAX_BULLETIN_LIMIT) {
      return errorResponse(ErrorCode.INVALID_LIMIT, {
        field: 'limit',
        reason: 'max',
        expected: `<= ${MAX_BULLETIN_LIMIT}`,
        actual: parsedLimit,
        max: MAX_BULLETIN_LIMIT,
      });
    }
    limit = parsedLimit;
  }

  return {
    offset,
    limit,
    hasPaging,
  };
}

/**
 * Return all commitments and current root from the bulletin board.
 */
export async function getBulletinHandler({ request, store }: ApiContext): Promise<Response> {
  const sessionResult = await validateSessionWithCapability(request.headers, store, { updateActivity: false });
  if (sessionResult instanceof Response) {
    return sessionResult;
  }
  const { session } = sessionResult;
  const finalizedRead = resolveSupportedFinalizedRead(session);
  if (finalizedRead.artifactState) {
    return buildUnsupportedFinalizedArtifactResponse(finalizedRead.artifactState);
  }

  const pagingParams = parseBulletinPagingParams(request.url);
  if (pagingParams instanceof Response) {
    return pagingParams;
  }

  const { offset, limit, hasPaging } = pagingParams;
  const commitments = resolveBulletinCommitments(session);
  const totalCommitments = commitments.length;
  const effectiveOffset = hasPaging ? Math.min(offset, totalCommitments) : 0;
  const sliceLimit = limit ?? Math.max(0, totalCommitments - effectiveOffset);
  const sliceEnd = Math.min(totalCommitments, effectiveOffset + sliceLimit);
  const pagedCommitments = hasPaging ? commitments.slice(effectiveOffset, sliceEnd) : commitments;

  const bulletinRoot = resolveBulletinRoot(session);
  if (!bulletinRoot) {
    return errorResponse(ErrorCode.INVALID_REQUEST, {
      details: 'BULLETIN_STATE_UNAVAILABLE',
    });
  }
  const treeSize = resolveBulletinTreeSize(session);
  const rootHistory = resolveBulletinRootHistory(session);

  const response: BulletinBoardResponse = {
    commitments: pagedCommitments,
    bulletinRoot,
    treeSize,
    timestamp: Date.now(),
  };

  if (hasPaging) {
    const hasMore = sliceEnd < totalCommitments;
    response.nextOffset = hasMore ? sliceEnd : null;
    response.hasMore = hasMore;
  }

  if (rootHistory.length > 0) {
    response.rootHistory = rootHistory;
  }

  return respondWithSchema(BulletinResponseSchema, response);
}

/**
 * Return minimal inclusion proof data for a vote.
 */
export async function getBulletinVoteProofHandler({
  request,
  store,
  params,
}: ApiContext<{ voteId: string }>): Promise<Response> {
  const startTime = performance.now();

  try {
    const voteId = params?.voteId;
    if (!voteId || !isValidVoteId(voteId)) {
      return voteProofErrorResponse(ErrorCode.INVALID_VOTE_ID);
    }

    const sessionResult = await validateSessionWithCapability(request.headers, store, { updateActivity: false });
    if (sessionResult instanceof Response) {
      return createPrivateNoStoreResponse(sessionResult);
    }
    const { session, sessionId } = sessionResult;
    if (!session.finalized) {
      return voteProofErrorResponse(ErrorCode.SESSION_NOT_FINALIZED);
    }
    const finalizedRead = resolveSupportedFinalizedRead(session);
    if (finalizedRead.artifactState) {
      return createPrivateNoStoreResponse(buildUnsupportedFinalizedArtifactResponse(finalizedRead.artifactState));
    }

    const userVoteId =
      session.userVoteIndex !== undefined ? session.votes.get(session.userVoteIndex)?.voteId : undefined;
    let isAllowed = Boolean(userVoteId && userVoteId === voteId);

    if (!isAllowed && finalizedRead.finalizationResult) {
      const scenarios = finalizedRead.finalizationResult.scenarios ?? [];
      const scenarioId = scenarios.length > 0 ? scenarios[0] : undefined;
      const affectedBotIds = finalizedRead.finalizationResult.tamperSummary?.affectedBotIds ?? [];
      if ((scenarioId === 'S3' || scenarioId === 'S4') && affectedBotIds.length > 0) {
        for (const botId of affectedBotIds) {
          const botVoteId = session.votes.get(botId)?.voteId;
          if (botVoteId && botVoteId === voteId) {
            isAllowed = true;
            break;
          }
        }
      }
    }

    if (!isAllowed) {
      return voteProofErrorResponse(ErrorCode.VOTE_NOT_FOUND);
    }

    let voteProof;
    try {
      voteProof = await store.getVoteByIdWithProof(sessionId, voteId);
    } catch (error) {
      if (error instanceof Error && error.message === 'CT_PROOF_UNAVAILABLE') {
        return voteProofErrorResponse(ErrorCode.VERIFICATION_FAILED, { details: 'CT_PROOF_UNAVAILABLE' });
      }
      throw error;
    }
    if (!voteProof) {
      return voteProofErrorResponse(ErrorCode.VERIFICATION_FAILED, { details: 'CT_PROOF_UNAVAILABLE' });
    }

    const proofData = {
      leafIndex: voteProof.leafIndex,
      merklePath: voteProof.merklePath.map((node) => normalizeHex(node, { allowEmpty: true })),
      treeSize: voteProof.treeSize,
      bulletinRootAtCast: normalizeHex(voteProof.bulletinRootAtCast, { allowEmpty: true }),
    };
    const responseData = {
      voteId,
      proof: proofData,
    };

    if (process.env.NODE_ENV === 'development') {
      const duration = performance.now() - startTime;
      logger.debug(`[API] Vote proof retrieved in ${duration.toFixed(2)}ms`, {
        voteId: voteId.substring(0, 8) + '...',
        pathLength: proofData.merklePath.length,
        responseSize: JSON.stringify(responseData).length,
      });
    }

    return respondWithSchema(BulletinProofResponseSchema, responseData, {
      headers: createPrivateNoStoreHeaders({
        'X-Content-Type-Options': 'nosniff',
      }),
    });
  } catch (error) {
    const voteId = params?.voteId;
    logger.error('[API] Error retrieving vote proof:', {
      voteId,
      error: error instanceof Error ? error.message : 'Unknown error',
      duration: performance.now() - startTime,
    });

    return voteProofErrorResponse(ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Generate a consistency proof between two tree sizes.
 */
export async function getConsistencyProofHandler({ request, store }: ApiContext): Promise<Response> {
  try {
    const sessionResult = await validateSessionWithCapability(request.headers, store, { updateActivity: false });
    if (sessionResult instanceof Response) {
      return sessionResult;
    }
    const { session } = sessionResult;
    const finalizedRead = resolveSupportedFinalizedRead(session);
    if (finalizedRead.artifactState) {
      return buildUnsupportedFinalizedArtifactResponse(finalizedRead.artifactState);
    }

    const { searchParams } = new URL(request.url);
    const oldSizeParam = searchParams.get('oldSize');
    const newSizeParam = searchParams.get('newSize');

    if (oldSizeParam === null) {
      return jsonResponse({ error: 'Missing required parameter: oldSize' }, { status: 400 });
    }

    if (newSizeParam === null) {
      return jsonResponse({ error: 'Missing required parameter: newSize' }, { status: 400 });
    }

    const oldSize = parseInt(oldSizeParam, 10);
    const newSize = parseInt(newSizeParam, 10);

    if (isNaN(oldSize) || isNaN(newSize)) {
      return jsonResponse({ error: 'Invalid parameter: oldSize and newSize must be integers' }, { status: 400 });
    }

    if (oldSize < 0) {
      return jsonResponse({ error: 'Invalid parameter: oldSize must be non-negative' }, { status: 400 });
    }

    if (newSize < 0) {
      return jsonResponse({ error: 'Invalid parameter: newSize must be non-negative' }, { status: 400 });
    }

    if (oldSize > newSize) {
      return jsonResponse({ error: 'Invalid parameters: oldSize cannot be greater than newSize' }, { status: 400 });
    }

    if (!session.bulletin) {
      return jsonResponse({ error: 'Bulletin board not initialized for this session' }, { status: 400 });
    }

    const currentTreeSize = session.bulletin.getSize();

    if (newSize > currentTreeSize) {
      return jsonResponse(
        { error: `Invalid parameter: newSize (${newSize}) exceeds current tree size (${currentTreeSize})` },
        { status: 400 },
      );
    }

    let proofNodes: string[] = [];
    let rootAtOldSize: string;
    let rootAtNewSize: string;

    let oldSubtreeHashes: string[] | undefined;
    let appendSubtreeHashes: string[] | undefined;

    if (oldSize === 0) {
      const { createHash } = await import('crypto');
      rootAtOldSize = createHash('sha256').digest('hex');
      rootAtNewSize = newSize === 0 ? createHash('sha256').digest('hex') : session.bulletin.getRootAtSize(newSize);
      proofNodes = [];
    } else if (oldSize === newSize) {
      rootAtOldSize = session.bulletin.getRootAtSize(oldSize);
      rootAtNewSize = rootAtOldSize;
      proofNodes = [];
    } else {
      try {
        const consistencyProof = session.bulletin.getConsistencyProof(oldSize, newSize);
        proofNodes = consistencyProof.proofNodes;
        oldSubtreeHashes = consistencyProof.oldSubtreeHashes;
        appendSubtreeHashes = consistencyProof.appendSubtreeHashes;
        rootAtOldSize = session.bulletin.getRootAtSize(oldSize);
        rootAtNewSize = session.bulletin.getRootAtSize(newSize);
      } catch (proofError) {
        return jsonResponse(
          {
            error: 'Failed to generate consistency proof',
            details: proofError instanceof Error ? proofError.message : 'Unknown error',
          },
          { status: 400 },
        );
      }
    }

    const response: ConsistencyProofResponse = {
      oldSize,
      newSize,
      rootAtOldSize,
      rootAtNewSize,
      proofNodes,
      oldSubtreeHashes,
      appendSubtreeHashes,
      timestamp: Date.now(),
    };

    return jsonResponse(response);
  } catch (error) {
    logger.error('Error generating consistency proof:', error);
    return jsonResponse(
      {
        error: 'Internal server error while generating consistency proof',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

function resolveBulletinRoot(session: SessionData): string | null {
  const latestSnapshot = getLatestCanonicalBulletinSnapshot(session, 'BulletinHandler');
  if (latestSnapshot) {
    return normalizeHex(latestSnapshot.root, { allowEmpty: true });
  }
  if (session.bulletin && session.votes.size === 0) {
    return normalizeHex(session.bulletin.getCurrentRoot(), { allowEmpty: true });
  }
  return null;
}

function resolveBulletinTreeSize(session: SessionData): number {
  const latestSnapshot = getLatestCanonicalBulletinSnapshot(session, 'BulletinHandler');
  if (latestSnapshot) {
    return latestSnapshot.treeSize;
  }
  if (session.bulletin && session.votes.size === 0) {
    return session.bulletin.getSize();
  }
  return session.votes.size;
}

type BulletinRootHistoryEntry = NonNullable<BulletinBoardResponse['rootHistory']>[number];

function resolveBulletinRootHistory(session: SessionData): BulletinRootHistoryEntry[] {
  return getCanonicalBulletinRootHistory(session, 'BulletinHandler').map((snapshot) => {
    const entry: BulletinRootHistoryEntry = {
      timestamp: snapshot.timestamp,
      bulletinRoot: normalizeHex(snapshot.root, { allowEmpty: true }),
      treeSize: snapshot.treeSize,
    };
    if (typeof snapshot.signature === 'string') {
      entry.signature = snapshot.signature;
    }
    return entry;
  });
}

function resolveBulletinCommitments(session: SessionData): string[] {
  if (session.bulletin) {
    const bulletinCommitments = session.bulletin
      .getCommitments()
      .map((commitment) => normalizeHex(commitment, { allowEmpty: true }));
    if (session.votes.size !== bulletinCommitments.length) {
      logger.warn('[API] bulletin/votes size mismatch', {
        bulletinSize: session.bulletin.getSize(),
        votesSize: session.votes.size,
      });
    }
    return bulletinCommitments;
  }

  return Array.from(session.votes.entries())
    .sort(([indexA], [indexB]) => indexA - indexB)
    .map(([, vote]) => vote.commit);
}
