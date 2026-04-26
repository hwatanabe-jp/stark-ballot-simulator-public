import type { ApiContext } from '@/server/api/context';
import { SessionResponseSchema } from '@/lib/validation/apiSchemas';
import { respondWithSchema } from '@/server/api/utils/responseSchema';
import {
  createSessionCapabilityToken,
  resolveSessionCapabilitySecret,
  resolveSessionCapabilityTtlSeconds,
} from '@/lib/security/sessionCapabilityToken';
import { isTruthyFlag } from '@/lib/utils/env';
import { ErrorCode } from '@/lib/errors/apiErrors';
import { errorResponse } from '@/server/http/response';
import { enforceSessionCreateRateLimit } from '@/server/api/middleware/rateLimit';
import { requireTurnstileToken } from '@/server/api/middleware/turnstile';
import { parseSessionCreateRequest } from '@/server/api/middleware/validation';

const DEFAULT_MAX_SESSIONS = 100;

function shouldRequireSessionCreateTurnstile(): boolean {
  return isTruthyFlag(process.env.SESSION_CREATE_TURNSTILE_REQUIRED);
}

function resolveMaxSessions(): number {
  const raw = process.env.MAX_SESSIONS?.trim();
  if (!raw) {
    return DEFAULT_MAX_SESSIONS;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid MAX_SESSIONS value: ${process.env.MAX_SESSIONS}. Expected a positive integer.`);
  }

  return value;
}

/**
 * Create a new voting session.
 */
export async function createSessionHandler({ request, store, clientIp }: ApiContext): Promise<Response> {
  const rateLimitResult = await enforceSessionCreateRateLimit(clientIp);
  if (rateLimitResult instanceof Response) {
    return rateLimitResult;
  }

  const parsedBody = await parseSessionCreateRequest(request);
  if (parsedBody instanceof Response) {
    return parsedBody;
  }

  if (shouldRequireSessionCreateTurnstile()) {
    await requireTurnstileToken({
      payload: parsedBody.raw,
      explicitToken: parsedBody.data.turnstileToken,
      clientIp: rateLimitResult.clientIp,
      expectedAction: 'session',
    });
  }

  const maxSessions = resolveMaxSessions();
  const activeSessions = await store.getActiveSessionCount();
  if (activeSessions >= maxSessions) {
    return errorResponse(ErrorCode.SESSION_LIMIT_EXCEEDED);
  }

  const { sessionId, electionId, electionConfigHash, logId, contractGeneration } = await store.createSession();
  if (!contractGeneration) {
    return errorResponse(ErrorCode.INTERNAL_ERROR, {
      details: 'Session store returned no contractGeneration',
    });
  }
  const capabilityToken = createSessionCapabilityToken(
    {
      sessionId,
      ttlSeconds: resolveSessionCapabilityTtlSeconds(),
    },
    resolveSessionCapabilitySecret(),
  );

  return respondWithSchema(SessionResponseSchema, {
    data: {
      sessionId,
      electionId,
      electionConfigHash,
      logId,
      contractGeneration,
      capabilityToken,
    },
  });
}
