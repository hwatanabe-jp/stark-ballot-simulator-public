import type { ApiHandlerArguments, ClientRateLimitedContext, RouteBoundResponse } from '../context';
import { createSessionRoute } from '@stark-ballot/api-contract/routes';
import { respondWithRoute } from '../utils/responseSchema';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import {
  resolveSessionCapabilitySecret,
  resolveSessionCapabilityTtlSeconds,
} from '../security/sessionCapabilityRuntimeConfig';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { createSessionWithinCapacity } from '@stark-ballot/application/session/create-session';
import { respondWithApplicationError } from '../utils/applicationErrorResponse';

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
}: ApiHandlerArguments<typeof createSessionRoute, ClientRateLimitedContext>): Promise<
  RouteBoundResponse<typeof createSessionRoute>
> {
  const { store } = context;
  const maxSessions = resolveMaxSessions();
  const result = await createSessionWithinCapacity(store, maxSessions);
  if (!result.ok) {
    return respondWithApplicationError(createSessionRoute, result.error);
  }
  const { sessionId, electionId, electionConfigHash, logId } = result.value;
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
