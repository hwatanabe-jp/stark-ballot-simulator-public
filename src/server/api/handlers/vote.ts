import { choiceToNumber } from '@/lib/crypto/sha256Commitment';
import { VOTE_CHOICES } from '@/shared/constants';
import type { ApiResponse } from '@/types';
import { ErrorCode } from '@/lib/errors/apiErrors';
import { errorResponse, jsonResponse } from '@/server/http/response';
import { BotVoter } from '@/lib/bot/botVoter';
import { generateVoteId } from '@/lib/vote/voteId';
import type { VoteReceipt } from '@/types/receipt';
import { DuplicateDetectorCache } from '@/lib/validation/duplicate-detector-cache';
import { computeCommitment } from '@/lib/zkvm/types';
import type { ApiContext } from '@/server/api/context';
import { consumeVoteRateLimit, enforceVoteRateLimit } from '@/server/api/middleware/rateLimit';
import { validateSessionWithCapability } from '@/server/api/middleware/session';
import { requireTurnstileToken } from '@/server/api/middleware/turnstile';
import { parseVoteRequest } from '@/server/api/middleware/validation';
import { VoteResponseSchema } from '@/lib/validation/apiSchemas';
import { respondWithSchema } from '@/server/api/utils/responseSchema';
import { normalizeHex } from '@/lib/utils/hex';
import { logger } from '@/lib/utils/logger';

const DEFAULT_DUPLICATE_DETECTOR_TTL_SECONDS = 30 * 60;
const DEFAULT_DUPLICATE_DETECTOR_CLEANUP_INTERVAL_SECONDS = 5 * 60;

const DUPLICATE_DETECTOR_TTL_MS = resolveDuplicateDetectorTtlMs();
const DUPLICATE_DETECTOR_CLEANUP_INTERVAL_MS = resolveDuplicateDetectorCleanupIntervalMs(DUPLICATE_DETECTOR_TTL_MS);

// Global duplicate detector cache (per session in production)
const duplicateDetectors = new DuplicateDetectorCache({
  ttlMs: DUPLICATE_DETECTOR_TTL_MS,
  cleanupIntervalMs: DUPLICATE_DETECTOR_CLEANUP_INTERVAL_MS,
});

/**
 * Submit a user vote and enqueue bot voting.
 */
export async function submitVoteHandler({ request, store, clientIp }: ApiContext): Promise<Response> {
  const rateLimitResult = await enforceVoteRateLimit(clientIp);
  if (rateLimitResult instanceof Response) {
    return rateLimitResult;
  }
  const resolvedClientIp = rateLimitResult.clientIp;

  const sessionResult = await validateSessionWithCapability(request.headers, store, { updateActivity: false });
  if (sessionResult instanceof Response) {
    return sessionResult;
  }
  const { session, sessionId } = sessionResult;

  // Parse request body only after cheap request rejection checks.
  const parsedBody = await parseVoteRequest(request);
  if (parsedBody instanceof Response) {
    return parsedBody;
  }

  const { commitment, vote, rand } = parsedBody.data;

  await requireTurnstileToken({
    payload: parsedBody.raw,
    explicitToken: parsedBody.data.turnstileToken,
    clientIp: resolvedClientIp,
    expectedAction: 'vote',
  });

  // Validate vote choice
  if (!VOTE_CHOICES.includes(vote)) {
    return errorResponse(ErrorCode.INVALID_VOTE_CHOICE);
  }

  // Check if already voted
  if (session.userVoteIndex !== undefined) {
    return errorResponse(ErrorCode.ALREADY_VOTED);
  }

  // Check if session is finalized
  if (session.finalized) {
    return errorResponse(ErrorCode.SESSION_FINALIZED);
  }

  if (!session.electionId) {
    return errorResponse(ErrorCode.INTERNAL_ERROR);
  }

  const normalizedRandom = normalizeHex(rand);
  const normalizedCommitment = normalizeHex(commitment);
  const choice = choiceToNumber(vote);
  const expectedCommitment = computeCommitment(session.electionId, choice, normalizedRandom);

  if (expectedCommitment !== normalizedCommitment) {
    return errorResponse(ErrorCode.INVALID_COMMITMENT);
  }

  // Get or create duplicate detector for this session
  const duplicateDetector = duplicateDetectors.getOrCreate(sessionId);

  // Generate unique vote ID and timestamp
  const voteId = generateVoteId();
  const timestamp = Date.now();

  // Check for duplicates
  const duplicateCheck = duplicateDetector.checkDuplicate(voteId, normalizedCommitment);
  if (duplicateCheck.isDuplicate) {
    const duplicateTypeMessage =
      duplicateCheck.duplicateType === 'voteId'
        ? 'Vote ID already exists. This may be a system error. Please try again.'
        : 'This commitment has already been submitted. Please ensure your vote is unique.';

    return jsonResponse<ApiResponse>(
      {
        error: ErrorCode.DUPLICATE_VOTE,
        message: duplicateTypeMessage,
      },
      { status: 409 },
    );
  }

  const consumeResult = await consumeVoteRateLimit(resolvedClientIp);
  if (consumeResult instanceof Response) {
    return consumeResult;
  }

  // Add vote to session with new fields
  const result = await store.addVote(sessionId, {
    voteId,
    vote: vote,
    rand: normalizedRandom,
    commit: normalizedCommitment,
    path: [], // Will be populated by the store
    timestamp,
  });

  // Update session activity
  await store.updateSession(sessionId);

  // Start bot voting after user vote
  const botVoter = new BotVoter();
  botVoter.startBotVoting(sessionId).catch((error) => {
    logger.error('Bot voting failed:', error);
  });

  const receipt: VoteReceipt = {
    voteId,
    commitment: normalizedCommitment,
    bulletinIndex: result.leafIndex,
    bulletinRootAtCast: normalizeHex(result.bulletinRootAtCast, { length: 64 }),
    timestamp,
  };

  return respondWithSchema(VoteResponseSchema, {
    data: receipt,
  });
}

function resolveDuplicateDetectorTtlMs(): number {
  const ttlSeconds = readPositiveNumber(process.env.AMPLIFY_DATA_TTL_SECONDS, DEFAULT_DUPLICATE_DETECTOR_TTL_SECONDS);
  return ttlSeconds * 1000;
}

function resolveDuplicateDetectorCleanupIntervalMs(ttlMs: number): number {
  const cleanupSeconds = DEFAULT_DUPLICATE_DETECTOR_CLEANUP_INTERVAL_SECONDS;
  return Math.min(cleanupSeconds * 1000, ttlMs);
}

function readPositiveNumber(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}
