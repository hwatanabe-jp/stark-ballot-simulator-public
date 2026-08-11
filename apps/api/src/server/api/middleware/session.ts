import type { SessionReadModel } from '@stark-ballot/application/session/session-read-model';
import type { ApiContextStore } from '../context';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { errorResponse } from '../../http/response';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/domain/session/capability';
import {
  type SessionCapabilityPayload,
  verifySessionCapabilityToken,
} from '@stark-ballot/domain/security/sessionCapabilityToken';
import {
  resolveSessionCapabilitySecret,
  resolveSessionCapabilityTtlSeconds,
} from '../security/sessionCapabilityRuntimeConfig';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

/**
 * Session validation result with session data and ID.
 */
export interface SessionValidationResult {
  session: SessionReadModel;
  sessionId: string;
}

/**
 * Options for session validation behavior.
 */
export interface SessionValidationOptions {
  updateActivity?: boolean;
}

export type SessionValidationStore = Pick<
  ApiContextStore,
  'getSessionIdentity' | 'getVotingRecord' | 'getCurrentFinalizationRecord' | 'touchSession'
>;

const defaultOptions: Required<SessionValidationOptions> = {
  updateActivity: true,
};

function resolveSessionOptions(options?: SessionValidationOptions): Required<SessionValidationOptions> {
  return { ...defaultOptions, ...options };
}

/**
 * Require a session capability token header.
 */
export function requireSessionCapability(headers: Headers): string | Response {
  const token = headers.get(SESSION_CAPABILITY_HEADER);
  if (!token) {
    return errorResponse(ErrorCode.SESSION_CAPABILITY_REQUIRED);
  }
  return token;
}

/**
 * Validate capability token for a specific session ID.
 */
export function validateSessionCapabilityForSession(
  profile: ResolvedRuntimeProfile,
  headers: Headers,
  sessionId: string,
): SessionCapabilityPayload | Response {
  const tokenResult = requireSessionCapability(headers);
  if (tokenResult instanceof Response) {
    return tokenResult;
  }

  let secret: string;
  let maxTtlSeconds: number;
  try {
    secret = resolveSessionCapabilitySecret(profile);
    maxTtlSeconds = resolveSessionCapabilityTtlSeconds(profile);
  } catch (error) {
    return errorResponse(ErrorCode.INTERNAL_ERROR, {
      details: error instanceof Error ? error.message : 'Session capability secret misconfigured',
    });
  }

  const verification = verifySessionCapabilityToken(tokenResult, secret, { sessionId, maxTtlSeconds });
  if (!verification.ok) {
    if (verification.reason === 'expired') {
      return errorResponse(ErrorCode.SESSION_CAPABILITY_EXPIRED);
    }
    return errorResponse(ErrorCode.SESSION_CAPABILITY_INVALID);
  }

  return verification.payload;
}

/**
 * Validate session existence by ID and optionally update activity.
 */
export async function validateSessionById(
  sessionId: string,
  store: SessionValidationStore,
  options?: SessionValidationOptions,
): Promise<SessionValidationResult | Response> {
  const resolvedOptions = resolveSessionOptions(options);
  const [identity, voting, finalization] = await Promise.all([
    store.getSessionIdentity(sessionId),
    store.getVotingRecord(sessionId),
    store.getCurrentFinalizationRecord(sessionId),
  ]);
  if (!identity || !voting || identity.sessionId !== sessionId || voting.sessionId !== sessionId) {
    return errorResponse(ErrorCode.SESSION_NOT_FOUND);
  }

  if (resolvedOptions.updateActivity) {
    await store.touchSession(sessionId);
  }

  return {
    session: {
      identity,
      voting,
      finalization,
    },
    sessionId,
  };
}
