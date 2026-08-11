import { choiceToNumber } from '@stark-ballot/domain/crypto/sha256Commitment';
import { VOTE_CHOICES } from '@stark-ballot/domain/shared/constants';
import { ApiError, ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { errorResponse } from '../../http/response';
import { BotVoter } from '@stark-ballot/application/bot/botVoter';
import { generateVoteId } from '@stark-ballot/domain/vote/voteId';
import type { VoteReceipt } from '@stark-ballot/domain/types/receipt';
import { DuplicateDetectorCache } from '@stark-ballot/validation/duplicate-detector-cache';
import { computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';
import type { ApiHandlerArguments, ClientRateLimitedContext, SessionAdmittedContext } from '../context';
import { consumeVoteRateLimit } from '../middleware/rateLimit';
import { submitVoteRoute } from '@stark-ballot/api-contract/routes';
import { respondWithRoute } from '../utils/responseSchema';
import { normalizeHex } from '@stark-ballot/domain/utils/hex';
import { logger } from '@stark-ballot/diagnostics/logger';

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
type SubmitVoteContext = SessionAdmittedContext & ClientRateLimitedContext;

export async function submitVoteHandler({
  input,
  context,
}: ApiHandlerArguments<typeof submitVoteRoute, SubmitVoteContext>): Promise<Response> {
  const { session, sessionId, store, rateLimitClientIp, runtimeProfile } = context;
  const { commitment, vote, rand } = input.body;

  // Validate vote choice
  if (!VOTE_CHOICES.includes(vote)) {
    return errorResponse(ErrorCode.INVALID_VOTE_CHOICE);
  }

  // Check if already voted
  if (session.voting.userParticipation.status === 'cast') {
    return errorResponse(ErrorCode.ALREADY_VOTED);
  }

  // Check if session is finalized
  if (session.finalization !== null) {
    return errorResponse(ErrorCode.SESSION_FINALIZED);
  }

  const normalizedRandom = normalizeHex(rand);
  const normalizedCommitment = normalizeHex(commitment);
  const choice = choiceToNumber(vote);
  const expectedCommitment = computeCommitment(session.identity.electionId, choice, normalizedRandom);

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

    return errorResponse(new ApiError(ErrorCode.DUPLICATE_VOTE, 409, duplicateTypeMessage));
  }

  const consumeResult = await consumeVoteRateLimit(runtimeProfile, rateLimitClientIp);
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
  await store.touchSession(sessionId);

  // Start bot voting after user vote
  const botVoter = new BotVoter(store);
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

  return respondWithRoute(submitVoteRoute, {
    status: 200,
    content: 'json',
    body: {
      data: {
        voteId: receipt.voteId,
        commitment: receipt.commitment,
        bulletinIndex: receipt.bulletinIndex,
        bulletinRootAtCast: receipt.bulletinRootAtCast,
        castAtMs: receipt.timestamp,
      },
    },
  });
}

function resolveDuplicateDetectorTtlMs(): number {
  const ttlSeconds = readPositiveNumber(
    process.env['VOTE_DUPLICATE_DETECTOR_TTL_SECONDS'],
    DEFAULT_DUPLICATE_DETECTOR_TTL_SECONDS,
  );
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
