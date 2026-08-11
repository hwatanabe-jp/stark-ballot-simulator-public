import type { ApiHandlerArguments, ClientRateLimitedContext } from '../context';
import { createSessionRoute } from '@stark-ballot/api-contract/routes';
import { respondWithRoute } from '../utils/responseSchema';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import {
  resolveSessionCapabilitySecret,
  resolveSessionCapabilityTtlSeconds,
} from '../security/sessionCapabilityRuntimeConfig';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { errorResponse } from '../../http/response';

const DEFAULT_MAX_SESSIONS = 100;

export function shouldRequireSessionCreateTurnstile(profile: ResolvedRuntimeProfile): boolean {
  return profile.turnstile.mode === 'required';
}

export function shouldBlockTargetPublicSessionCreate(
  profile: ResolvedRuntimeProfile,
  operatorGatedDevelop: boolean,
): boolean {
  if (profile.target.kind !== 'aws') {
    return false;
  }
  if (!profile.turnstile.publicSessionCreate) {
    return true;
  }
  return profile.turnstile.mode === 'operator-gated' && !operatorGatedDevelop;
}

function resolveMaxSessions(): number {
  const raw = process.env['MAX_SESSIONS']?.trim();
  if (!raw) {
    return DEFAULT_MAX_SESSIONS;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid MAX_SESSIONS value: ${process.env['MAX_SESSIONS']}. Expected a positive integer.`);
  }

  return value;
}

/**
 * Create a new voting session.
 */
export async function createSessionHandler({
  context,
}: ApiHandlerArguments<typeof createSessionRoute, ClientRateLimitedContext>): Promise<Response> {
  const { store } = context;
  const maxSessions = resolveMaxSessions();
  const activeSessions = await store.getActiveSessionCount();
  if (activeSessions >= maxSessions) {
    return errorResponse(ErrorCode.SESSION_LIMIT_EXCEEDED);
  }

  const { sessionId, electionId, electionConfigHash, logId } = await store.createSession();
  if (!sessionId || !electionId || !electionConfigHash || !logId) {
    return errorResponse(ErrorCode.INTERNAL_ERROR, {
      details: 'Session store returned incomplete identity authority',
    });
  }
  const capabilityToken = createSessionCapabilityToken(
    {
      sessionId,
      ttlSeconds: resolveSessionCapabilityTtlSeconds(context.runtimeProfile),
    },
    resolveSessionCapabilitySecret(context.runtimeProfile),
  );

  return respondWithRoute(createSessionRoute, {
    status: 200,
    content: 'json',
    body: {
      data: {
        sessionId,
        electionId,
        electionConfigHash,
        logId,
        capabilityToken,
      },
    },
  });
}
