import type { ApiContext } from '../context';
import { SessionResponseSchema } from '@stark-ballot/api-contract/validation/apiSchemas';
import { respondWithSchema } from '../utils/responseSchema';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import {
  resolveSessionCapabilitySecret,
  resolveSessionCapabilityTtlSeconds,
} from '../security/sessionCapabilityRuntimeConfig';
import { isTruthyFlag } from '@stark-ballot/runtime-config/env/flags';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { errorResponse } from '../../http/response';
import { enforceSessionCreateRateLimit } from '../middleware/rateLimit';
import { requireTurnstileToken } from '../middleware/turnstile';
import { parseSessionCreateRequest } from '../middleware/validation';
import { extractTurnstileToken } from '../security/turnstile';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { isOperatorGatedDevelopRequest } from '../security/developOperatorGate';

const DEFAULT_MAX_SESSIONS = 100;

function shouldRequireSessionCreateTurnstile(): boolean {
  return isTruthyFlag(process.env['SESSION_CREATE_TURNSTILE_REQUIRED']);
}

function shouldBlockTargetPublicSessionCreate(request: Request): boolean {
  if (process.env['TARGET_AWS_RUNTIME'] !== '1') {
    return false;
  }
  if (!isTruthyFlag(process.env['TARGET_PUBLIC_SESSION_CREATE_ENABLED'])) {
    return true;
  }
  return !shouldRequireSessionCreateTurnstile() && !isOperatorGatedDevelopRequest(request);
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
export async function createSessionHandler({ request, store, clientIp }: ApiContext): Promise<Response> {
  if (shouldBlockTargetPublicSessionCreate(request)) {
    return errorResponse(ErrorCode.SESSION_NOT_FOUND, {
      details:
        'Target public session creation requires explicit public enablement with server-side Turnstile or the operator-gated develop exception',
    });
  }

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
      payload: parsedBody.data,
      ...omitUndefinedProperties({ explicitToken: extractTurnstileToken(parsedBody.data) }),
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
