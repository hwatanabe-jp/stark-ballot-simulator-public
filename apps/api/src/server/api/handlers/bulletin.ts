import type { ApiContext } from '../context';
import { ErrorCode, type ApiError, type ErrorDetails } from '@stark-ballot/api-contract/errors/apiErrors';
import { errorResponse, jsonResponse } from '../../http/response';
import { toApiErrorPayload } from '@stark-ballot/api-contract/errors/errorPayload';
import type { ConsistencyProofResponse } from '@stark-ballot/api-contract/types/api/consistency-proof';
import { validateSessionWithCapability } from '../middleware/session';
import type { SessionData } from '@stark-ballot/domain/types/server';
import {
  BulletinProofResponseSchema,
  BulletinResponseSchema,
  ConsistencyProofResponseSchema,
} from '@stark-ballot/api-contract/validation/apiSchemas';
import { respondWithSchema } from '../utils/responseSchema';
import {
  getCanonicalBulletinRootHistory,
  getLatestCanonicalBulletinSnapshot,
} from '@stark-ballot/domain/bulletin/ctSessionState';
import { normalizeHex } from '@stark-ballot/domain/utils/hex';
import { logger } from '@stark-ballot/diagnostics/logger';
import {
  buildUnsupportedFinalizedArtifactResponse,
  resolveSupportedFinalizedRead,
} from '../utils/currentArtifactAdmission';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

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
const NON_NEGATIVE_INTEGER_QUERY_PATTERN = /^(0|[1-9]\d*)$/;

function parseNonNegativeIntegerQueryParam(value: string): number | null {
  if (!NON_NEGATIVE_INTEGER_QUERY_PATTERN.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

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
  if (process.env['NODE_ENV'] === 'test' && voteId === 'non-existent-id') {
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
    ...omitUndefinedProperties({ limit }),
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

    if (process.env['NODE_ENV'] === 'development') {
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
      return errorResponse(ErrorCode.INVALID_SIZE, { details: 'Missing required parameter: oldSize' });
    }

    if (newSizeParam === null) {
      return errorResponse(ErrorCode.INVALID_SIZE, { details: 'Missing required parameter: newSize' });
    }

    const oldSize = parseNonNegativeIntegerQueryParam(oldSizeParam);
    const newSize = parseNonNegativeIntegerQueryParam(newSizeParam);

    if (oldSize === null || newSize === null) {
      return errorResponse(ErrorCode.INVALID_SIZE, { details: 'oldSize and newSize must be non-negative integers' });
    }

    if (oldSize > newSize) {
      return errorResponse(ErrorCode.INVALID_SIZE, { details: 'oldSize cannot be greater than newSize' });
    }

    if (!session.bulletin) {
      return errorResponse(ErrorCode.INVALID_SIZE, { details: 'Bulletin board not initialized for this session' });
    }

    const currentTreeSize = session.bulletin.getSize();

    if (newSize > currentTreeSize) {
      return errorResponse(ErrorCode.INVALID_SIZE, {
        details: `newSize (${newSize}) exceeds current tree size (${currentTreeSize})`,
      });
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
        return errorResponse(ErrorCode.INVALID_SIZE, {
          details: proofError instanceof Error ? proofError.message : 'Failed to generate consistency proof',
        });
      }
    }

    const response: ConsistencyProofResponse = {
      oldSize,
      newSize,
      rootAtOldSize: normalizeHex(rootAtOldSize, { allowEmpty: true }),
      rootAtNewSize: normalizeHex(rootAtNewSize, { allowEmpty: true }),
      proofNodes: proofNodes.map((node) => normalizeHex(node, { allowEmpty: true })),
      ...omitUndefinedProperties({ oldSubtreeHashes, appendSubtreeHashes }),
      timestamp: Date.now(),
    };

    return respondWithSchema(ConsistencyProofResponseSchema, response);
  } catch (error) {
    logger.error('Error generating consistency proof:', error);
    return errorResponse(ErrorCode.INTERNAL_ERROR, {
      details: error instanceof Error ? error.message : 'Internal server error while generating consistency proof',
    });
  }
}

function resolveBulletinRoot(session: SessionData): string | null {
  const latestSnapshot = getLatestCanonicalBulletinSnapshot(session);
  if (latestSnapshot) {
    return normalizeHex(latestSnapshot.root, { allowEmpty: true });
  }
  if (session.bulletin && session.votes.size === 0) {
    return normalizeHex(session.bulletin.getCurrentRoot(), { allowEmpty: true });
  }
  return null;
}

function resolveBulletinTreeSize(session: SessionData): number {
  const latestSnapshot = getLatestCanonicalBulletinSnapshot(session);
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
  return getCanonicalBulletinRootHistory(session).map((snapshot) => {
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
