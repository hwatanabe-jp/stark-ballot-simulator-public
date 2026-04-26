import { BOT_COUNT } from '@/shared/constants';
import { ErrorCode } from '@/lib/errors/apiErrors';
import type { ApiContext } from '@/server/api/context';
import { errorResponse } from '@/server/http/response';
import { validateSessionWithCapability } from '@/server/api/middleware/session';
import { BotDataResponseSchema } from '@/lib/validation/apiSchemas';
import { respondWithSchema } from '@/server/api/utils/responseSchema';
import { addHexPrefix, isValidHexString, normalizeHexString } from '@/lib/utils/hex';
import { logger } from '@/lib/utils/logger';
import {
  buildUnsupportedFinalizedArtifactResponse,
  resolveSupportedFinalizedRead,
} from '@/server/api/utils/currentArtifactAdmission';

/**
 * Return bot vote data for a finalized session.
 */
export async function getBotDataHandler({ request, store, params }: ApiContext<{ id: string }>): Promise<Response> {
  const id = params?.id;
  if (!id) {
    return errorResponse(ErrorCode.INVALID_BOT_ID);
  }

  const botId = parseInt(id, 10);
  if (isNaN(botId) || botId < 1 || botId > BOT_COUNT) {
    return errorResponse(ErrorCode.INVALID_BOT_ID);
  }

  const sessionResult = await validateSessionWithCapability(request.headers, store, { updateActivity: false });
  if (sessionResult instanceof Response) {
    return sessionResult;
  }
  const { session } = sessionResult;

  if (!session.finalized) {
    return errorResponse(ErrorCode.SESSION_NOT_FINALIZED);
  }
  const finalizedRead = resolveSupportedFinalizedRead(session);
  if (finalizedRead.artifactState) {
    return buildUnsupportedFinalizedArtifactResponse(finalizedRead.artifactState);
  }

  const voteData = session.votes.get(botId);
  if (!voteData) {
    return errorResponse(ErrorCode.BOT_DATA_NOT_FOUND);
  }
  try {
    const normalizeHex32 = (value: string | undefined, label: string): string => {
      if (!isValidHexString(value ?? '', 32)) {
        throw new Error(`Invalid ${label} (expected 32-byte hex)`);
      }
      return addHexPrefix(normalizeHexString(value ?? ''));
    };

    if (!session.bulletin) {
      throw new Error('Bulletin board unavailable for CT proof');
    }
    if (!voteData.voteId) {
      throw new Error('Vote ID missing for bot vote');
    }

    const normalizedCommitment = normalizeHex32(voteData.commit, 'commitment');
    const normalizedRandom = normalizeHex32(voteData.rand, 'random');

    const treeSizeAtCast = botId + 1;
    const proof = session.bulletin.getInclusionProof(voteData.voteId, treeSizeAtCast);
    if (!proof || !Array.isArray(proof.proofNodes) || proof.proofNodes.length === 0) {
      throw new Error('Inclusion proof unavailable for bot vote');
    }

    if (proof.leafIndex !== botId) {
      throw new Error('Bot ID does not match inclusion proof leaf index');
    }

    const merklePath = proof.proofNodes.map((node) => normalizeHex32(node, 'merklePath item'));
    const bulletinRootAtCast = normalizeHex32(proof.rootHash, 'bulletinRootAtCast');

    return respondWithSchema(BotDataResponseSchema, {
      data: {
        id: botId,
        vote: voteData.vote,
        random: normalizedRandom,
        commitment: normalizedCommitment,
        voteId: voteData.voteId,
        timestamp: voteData.timestamp ?? session.createdAt,
        proof: {
          leafIndex: proof.leafIndex,
          merklePath,
          treeSize: proof.treeSize,
          bulletinRootAtCast,
        },
      },
    });
  } catch (error) {
    logger.error('[API] Failed to build bot data payload', error);
    return errorResponse(ErrorCode.INTERNAL_ERROR, { details: 'Bot data proof generation failed' });
  }
}
