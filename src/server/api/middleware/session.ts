import type { VoteStore } from '@/types/voteStore';
import type { SessionData } from '@/types/server';
import { ErrorCode } from '@/lib/errors/apiErrors';
import { errorResponse } from '@/server/http/response';
import { SESSION_CAPABILITY_HEADER, SESSION_ID_HEADER } from '@/lib/session/capability';
import {
  resolveSessionCapabilitySecret,
  type SessionCapabilityPayload,
  verifySessionCapabilityToken,
} from '@/lib/security/sessionCapabilityToken';
import { isRecoverableCurrentLiveSession } from '@/lib/contract';

/**
 * Session validation result with session data and ID.
 */
export interface SessionValidationResult {
  session: SessionData;
  sessionId: string;
}

/**
 * Options for session validation behavior.
 */
export interface SessionValidationOptions {
  updateActivity?: boolean;
}

const defaultOptions: Required<SessionValidationOptions> = {
  updateActivity: true,
};

function resolveSessionOptions(options?: SessionValidationOptions): Required<SessionValidationOptions> {
  return { ...defaultOptions, ...options };
}

function isUnsupportedLiveSession(session: SessionData): boolean {
  return !session.finalized && !isRecoverableCurrentLiveSession(session);
}

/**
 * Require a session ID header and return it when present.
 */
export function requireSessionId(headers: Headers): string | Response {
  const sessionId = headers.get(SESSION_ID_HEADER);
  if (!sessionId) {
    return errorResponse(ErrorCode.SESSION_ID_REQUIRED);
  }
  return sessionId;
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
  headers: Headers,
  sessionId: string,
): SessionCapabilityPayload | Response {
  const tokenResult = requireSessionCapability(headers);
  if (tokenResult instanceof Response) {
    return tokenResult;
  }

  let secret: string;
  try {
    secret = resolveSessionCapabilitySecret();
  } catch (error) {
    return errorResponse(ErrorCode.INTERNAL_ERROR, {
      details: error instanceof Error ? error.message : 'Session capability secret misconfigured',
    });
  }

  const verification = verifySessionCapabilityToken(tokenResult, secret, { sessionId });
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
  store: VoteStore,
  options?: SessionValidationOptions,
): Promise<SessionValidationResult | Response> {
  const resolvedOptions = resolveSessionOptions(options);
  const session = await store.getSession(sessionId);
  if (!session) {
    return errorResponse(ErrorCode.SESSION_NOT_FOUND);
  }
  if (isUnsupportedLiveSession(session)) {
    return errorResponse(ErrorCode.SESSION_NOT_FOUND);
  }

  if (resolvedOptions.updateActivity) {
    await store.updateSession(sessionId);
  }

  return { session, sessionId };
}

/**
 * Validate session from request headers and return session data.
 */
export async function validateSession(
  headers: Headers,
  store: VoteStore,
  options?: SessionValidationOptions,
): Promise<SessionValidationResult | Response> {
  const sessionIdResult = requireSessionId(headers);
  if (sessionIdResult instanceof Response) {
    return sessionIdResult;
  }

  return validateSessionById(sessionIdResult, store, options);
}

/**
 * Validate session ID + capability token + session existence.
 */
export async function validateSessionWithCapability(
  headers: Headers,
  store: VoteStore,
  options?: SessionValidationOptions,
): Promise<SessionValidationResult | Response> {
  const sessionIdResult = requireSessionId(headers);
  if (sessionIdResult instanceof Response) {
    return sessionIdResult;
  }

  const capabilityResult = validateSessionCapabilityForSession(headers, sessionIdResult);
  if (capabilityResult instanceof Response) {
    return capabilityResult;
  }

  return validateSessionById(sessionIdResult, store, options);
}

/**
 * Validate session and ensure the user has already voted.
 */
export async function validateSessionWithVote(
  headers: Headers,
  store: VoteStore,
  options?: SessionValidationOptions,
): Promise<SessionValidationResult | Response> {
  const result = await validateSession(headers, store, options);

  if (result instanceof Response) {
    return result;
  }

  if (result.session.userVoteIndex === undefined) {
    return errorResponse(ErrorCode.USER_NOT_VOTED);
  }

  return result;
}

/**
 * Validate session and ensure it has been finalized.
 */
export async function validateFinalizedSession(
  headers: Headers,
  store: VoteStore,
  options?: SessionValidationOptions,
): Promise<SessionValidationResult | Response> {
  const result = await validateSession(headers, store, options);

  if (result instanceof Response) {
    return result;
  }

  if (!result.session.finalized) {
    return errorResponse(ErrorCode.SESSION_NOT_FINALIZED);
  }

  return result;
}
