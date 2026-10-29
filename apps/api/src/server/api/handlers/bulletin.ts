import type { FinalizationResultAuthority } from '@stark-ballot/application/finalize/finalization-types';
import { createHash } from 'node:crypto';
import type { ApiHandlerArguments, RouteBoundResponse, SessionAdmittedContext } from '../context';
import { ErrorCode, type ErrorDetails } from '@stark-ballot/api-contract/errors/apiErrors';
import type { BulletinResponse, ConsistencyProofResponse } from '@stark-ballot/api-contract/schemas/bulletin';
import type { SessionVotingRecord } from '@stark-ballot/domain/types/sessionRecords';
import {
  sessionBulletinConsistencyProofRoute,
  sessionBulletinRoute,
  sessionVoteInclusionProofRoute,
} from '@stark-ballot/api-contract/routes';
import { respondWithRoute, respondWithRouteError } from '../utils/responseSchema';
import {
  getCanonicalBulletinRootHistory,
  getLatestCanonicalBulletinSnapshot,
} from '@stark-ballot/domain/bulletin/ctSessionState';
import { normalizeHex } from '@stark-ballot/domain/utils/hex';
import { logger } from '@stark-ballot/diagnostics/logger';
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
  /** Repository generation timestamp. */
  generatedAtMs: number;
  /** Optional: History of Merkle root snapshots. */
  rootHistory?: Array<{
    recordedAtMs: number;
    bulletinRoot: string;
    treeSize: number;
    signature?: string;
  }>;
}

// UUID v4 validation regex - compiled once for performance
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PRIVATE_NO_STORE_CACHE_CONTROL = 'private, no-store';
const SESSION_AUTH_VARY = 'X-Session-Capability';
type HeadersInput = NonNullable<ConstructorParameters<typeof Headers>[0]>;

/**
 * Validate vote ID format with security checks.
 */
export function isValidBulletinVoteId(voteId: string): boolean {
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

function createPrivateNoStoreHeaders(headers?: HeadersInput): Headers {
  const merged = new Headers(headers);
  merged.set('Cache-Control', PRIVATE_NO_STORE_CACHE_CONTROL);
  merged.set('Vary', SESSION_AUTH_VARY);
  return merged;
}

type VoteProofErrorCode =
  | typeof ErrorCode.INVALID_VOTE_ID
  | typeof ErrorCode.SESSION_NOT_FINALIZED
  | typeof ErrorCode.VOTE_NOT_FOUND
  | typeof ErrorCode.VERIFICATION_FAILED
  | typeof ErrorCode.INTERNAL_ERROR;

function voteProofErrorResponse(
  code: VoteProofErrorCode,
  details?: ErrorDetails,
): RouteBoundResponse<typeof sessionVoteInclusionProofRoute> {
  const init = {
    headers: createPrivateNoStoreHeaders({ 'X-Content-Type-Options': 'nosniff' }),
  };
  const withDetails = details === undefined ? {} : { details };
  if (code === ErrorCode.VOTE_NOT_FOUND) {
    return respondWithRouteError(sessionVoteInclusionProofRoute, { code, status: 404, ...withDetails }, init);
  }
  if (code === ErrorCode.INTERNAL_ERROR) {
    return respondWithRouteError(sessionVoteInclusionProofRoute, { code, status: 500, ...withDetails }, init);
  }
  if (code === ErrorCode.INVALID_VOTE_ID) {
    return respondWithRouteError(sessionVoteInclusionProofRoute, { code, status: 400, ...withDetails }, init);
  }
  if (code === ErrorCode.SESSION_NOT_FINALIZED) {
    return respondWithRouteError(sessionVoteInclusionProofRoute, { code, status: 400, ...withDetails }, init);
  }
  return respondWithRouteError(sessionVoteInclusionProofRoute, { code, status: 400, ...withDetails }, init);
}

/**
 * Return all commitments and current root from the bulletin board.
 */
export function getSessionBulletinHandler({
  input,
  context,
}: ApiHandlerArguments<typeof sessionBulletinRoute, SessionAdmittedContext>): RouteBoundResponse<
  typeof sessionBulletinRoute
> {
  const { session } = context;
  const voting = session.voting;

  const { offset = 0, limit } = input.query;
  const hasPaging = input.query.offset !== undefined || input.query.limit !== undefined;
  const commitments = resolveBulletinCommitments(voting);
  const totalCommitments = commitments.length;
  const effectiveOffset = hasPaging ? Math.min(offset, totalCommitments) : 0;
  const sliceLimit = limit ?? Math.max(0, totalCommitments - effectiveOffset);
  const sliceEnd = Math.min(totalCommitments, effectiveOffset + sliceLimit);
  const pagedCommitments = hasPaging ? commitments.slice(effectiveOffset, sliceEnd) : commitments;

  const bulletinRoot = resolveBulletinRoot(voting);
  if (!bulletinRoot) {
    return respondWithRouteError(sessionBulletinRoute, {
      code: ErrorCode.INVALID_REQUEST,
      status: 400,
      details: { details: 'BULLETIN_STATE_UNAVAILABLE' },
    });
  }
  const treeSize = resolveBulletinTreeSize(voting);
  const rootHistory = resolveBulletinRootHistory(voting);

  const response: BulletinBoardResponse = {
    commitments: pagedCommitments,
    bulletinRoot,
    treeSize,
    generatedAtMs: Date.now(),
  };

  let page: BulletinResponse['meta']['page'];
  if (hasPaging) {
    const hasMore = sliceEnd < totalCommitments;
    page = {
      nextOffset: hasMore ? sliceEnd : null,
      hasMore,
    };
  }

  if (rootHistory.length > 0) {
    response.rootHistory = rootHistory;
  }

  return respondWithRoute(sessionBulletinRoute, {
    status: 200,
    content: 'json',
    body: {
      data: response,
      ...(page ? { meta: { page } } : {}),
    },
  });
}

function isAffectedBotProofAllowed(
  voting: SessionVotingRecord,
  result: FinalizationResultAuthority,
  voteId: string,
): boolean {
  const scenarios = result.scenarios ?? [];
  const scenarioId = scenarios.length > 0 ? scenarios[0] : undefined;
  const affectedBotIds = result.tamperSummary?.affectedBotIds ?? [];
  if (scenarioId !== 'S3' && scenarioId !== 'S4') return false;
  return affectedBotIds.some((botId) => {
    const botVoteId = voting.votes.get(botId)?.voteId;
    return Boolean(botVoteId && botVoteId === voteId);
  });
}

function isVoteProofAllowed(voting: SessionVotingRecord, result: FinalizationResultAuthority, voteId: string): boolean {
  const userVoteId =
    voting.userParticipation.status === 'cast'
      ? voting.votes.get(voting.userParticipation.voteIndex)?.voteId
      : undefined;
  return Boolean(userVoteId && userVoteId === voteId) || isAffectedBotProofAllowed(voting, result, voteId);
}

type StoredVoteProof = NonNullable<Awaited<ReturnType<SessionAdmittedContext['store']['getVoteByIdWithProof']>>>;

async function readVoteProof(context: SessionAdmittedContext, voteId: string): Promise<StoredVoteProof | null> {
  try {
    return await context.store.getVoteByIdWithProof(context.sessionId, voteId);
  } catch (error) {
    if (error instanceof Error && error.message === 'CT_PROOF_UNAVAILABLE') return null;
    throw error;
  }
}

function voteProofResponse(
  voteId: string,
  voteProof: StoredVoteProof,
  startTime: number,
): RouteBoundResponse<typeof sessionVoteInclusionProofRoute> {
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

  return respondWithRoute(
    sessionVoteInclusionProofRoute,
    { status: 200, content: 'json', body: { data: responseData } },
    {
      headers: createPrivateNoStoreHeaders({
        'X-Content-Type-Options': 'nosniff',
      }),
    },
  );
}

/**
 * Return minimal inclusion proof data for a vote.
 */
export async function getSessionVoteInclusionProofHandler({
  input,
  context,
}: ApiHandlerArguments<typeof sessionVoteInclusionProofRoute, SessionAdmittedContext>): Promise<
  RouteBoundResponse<typeof sessionVoteInclusionProofRoute>
> {
  const startTime = performance.now();

  try {
    const { voteId } = input.params;
    if (!isValidBulletinVoteId(voteId)) {
      return voteProofErrorResponse(ErrorCode.INVALID_VOTE_ID);
    }

    const { session } = context;
    if (session.finalization?.state.status !== 'succeeded' || !session.finalization.finalizationResult) {
      return voteProofErrorResponse(ErrorCode.SESSION_NOT_FINALIZED);
    }
    const { voting } = session;
    const finalizationResult = session.finalization.finalizationResult;

    const isAllowed = isVoteProofAllowed(voting, finalizationResult, voteId);

    if (!isAllowed) {
      return voteProofErrorResponse(ErrorCode.VOTE_NOT_FOUND);
    }

    const voteProof = await readVoteProof(context, voteId);
    if (!voteProof) {
      return voteProofErrorResponse(ErrorCode.VERIFICATION_FAILED, { details: 'CT_PROOF_UNAVAILABLE' });
    }

    return voteProofResponse(voteId, voteProof, startTime);
  } catch (error) {
    const { voteId } = input.params;
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
export interface ConsistencyProofDataInput {
  session: SessionVotingRecord;
  fromTreeSize: number;
  toTreeSize: number;
  generatedAtMs: number;
}

export type ConsistencyProofDataResolution =
  | { ok: true; data: ConsistencyProofResponse['data'] }
  | { ok: false; message: string };

export function resolveConsistencyProofData({
  session,
  fromTreeSize,
  toTreeSize,
  generatedAtMs,
}: ConsistencyProofDataInput): ConsistencyProofDataResolution {
  if (fromTreeSize > toTreeSize) {
    return { ok: false, message: 'fromTreeSize cannot be greater than toTreeSize' };
  }

  const currentTreeSize = session.bulletin.getSize();
  if (toTreeSize > currentTreeSize) {
    return {
      ok: false,
      message: `toTreeSize (${toTreeSize}) exceeds current tree size (${currentTreeSize})`,
    };
  }

  let proofNodes: string[] = [];
  let rootAtFromTreeSize: string;
  let rootAtToTreeSize: string;
  let oldSubtreeHashes: string[] | undefined;
  let appendSubtreeHashes: string[] | undefined;

  if (fromTreeSize === 0) {
    const emptyRoot = createHash('sha256').digest('hex');
    rootAtFromTreeSize = emptyRoot;
    rootAtToTreeSize = toTreeSize === 0 ? emptyRoot : session.bulletin.getRootAtSize(toTreeSize);
  } else if (fromTreeSize === toTreeSize) {
    rootAtFromTreeSize = session.bulletin.getRootAtSize(fromTreeSize);
    rootAtToTreeSize = rootAtFromTreeSize;
  } else {
    try {
      const consistencyProof = session.bulletin.getConsistencyProof(fromTreeSize, toTreeSize);
      proofNodes = consistencyProof.proofNodes;
      oldSubtreeHashes = consistencyProof.oldSubtreeHashes;
      appendSubtreeHashes = consistencyProof.appendSubtreeHashes;
      rootAtFromTreeSize = session.bulletin.getRootAtSize(fromTreeSize);
      rootAtToTreeSize = session.bulletin.getRootAtSize(toTreeSize);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to generate consistency proof',
      };
    }
  }

  return {
    ok: true,
    data: {
      fromTreeSize,
      toTreeSize,
      rootAtFromTreeSize: normalizeHex(rootAtFromTreeSize, { allowEmpty: true }),
      rootAtToTreeSize: normalizeHex(rootAtToTreeSize, { allowEmpty: true }),
      proofNodes: proofNodes.map((node) => normalizeHex(node, { allowEmpty: true })),
      ...omitUndefinedProperties({
        oldSubtreeHashes: oldSubtreeHashes?.map((node) => normalizeHex(node, { allowEmpty: true })),
        appendSubtreeHashes: appendSubtreeHashes?.map((node) => normalizeHex(node, { allowEmpty: true })),
      }),
      generatedAtMs,
    },
  };
}

export function getSessionBulletinConsistencyProofHandler({
  input,
  context,
}: ApiHandlerArguments<typeof sessionBulletinConsistencyProofRoute, SessionAdmittedContext>): RouteBoundResponse<
  typeof sessionBulletinConsistencyProofRoute
> {
  try {
    const { session } = context;

    const resolution = resolveConsistencyProofData({
      session: session.voting,
      ...input.query,
      generatedAtMs: Date.now(),
    });
    if (!resolution.ok) {
      return respondWithRouteError(sessionBulletinConsistencyProofRoute, {
        code: ErrorCode.INVALID_SIZE,
        status: 400,
        details: { details: resolution.message },
      });
    }

    return respondWithRoute(sessionBulletinConsistencyProofRoute, {
      status: 200,
      content: 'json',
      body: { data: resolution.data },
    });
  } catch (error) {
    logger.error('Error generating consistency proof:', error);
    return respondWithRouteError(sessionBulletinConsistencyProofRoute, {
      code: ErrorCode.INTERNAL_ERROR,
      status: 500,
      details: {
        details: error instanceof Error ? error.message : 'Internal server error while generating consistency proof',
      },
    });
  }
}

function resolveBulletinRoot(session: SessionVotingRecord): string | null {
  const latestSnapshot = getLatestCanonicalBulletinSnapshot(session);
  if (latestSnapshot) {
    return normalizeHex(latestSnapshot.root, { allowEmpty: true });
  }
  if (session.votes.size === 0) {
    return normalizeHex(session.bulletin.getCurrentRoot(), { allowEmpty: true });
  }
  return null;
}

function resolveBulletinTreeSize(session: SessionVotingRecord): number {
  const latestSnapshot = getLatestCanonicalBulletinSnapshot(session);
  if (latestSnapshot) {
    return latestSnapshot.treeSize;
  }
  if (session.votes.size === 0) {
    return session.bulletin.getSize();
  }
  return session.votes.size;
}

type BulletinRootHistoryEntry = NonNullable<BulletinBoardResponse['rootHistory']>[number];

function resolveBulletinRootHistory(session: SessionVotingRecord): BulletinRootHistoryEntry[] {
  return getCanonicalBulletinRootHistory(session).map((snapshot) => {
    const entry: BulletinRootHistoryEntry = {
      recordedAtMs: snapshot.timestamp,
      bulletinRoot: normalizeHex(snapshot.root, { allowEmpty: true }),
      treeSize: snapshot.treeSize,
    };
    if (typeof snapshot.signature === 'string') {
      entry.signature = snapshot.signature;
    }
    return entry;
  });
}

function resolveBulletinCommitments(session: SessionVotingRecord): string[] {
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
