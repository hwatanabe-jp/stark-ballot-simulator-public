import { ApplicationErrorCode, type ApplicationExpectedErrorOf, type Result } from '@stark-ballot/application';
import { parseSessionIdentityRecord, type SessionIdentityRecord } from '@stark-ballot/domain/types/sessionRecords';
import type { SessionIdentityStore, SessionVotingStore } from '@stark-ballot/domain/types/voteStore';

export type CreateSessionExpectedError = ApplicationExpectedErrorOf<
  typeof ApplicationErrorCode.INTERNAL_ERROR | typeof ApplicationErrorCode.SESSION_LIMIT_EXCEEDED
>;

export type SessionCreationStore = Pick<SessionIdentityStore, 'createSession'> &
  Pick<SessionVotingStore, 'getActiveSessionCount'>;

/** Apply application-owned capacity policy, while allowing storage/I/O failures to propagate. */
export async function createSessionWithinCapacity(
  store: SessionCreationStore,
  maxSessions: number,
): Promise<Result<SessionIdentityRecord, CreateSessionExpectedError>> {
  if (!Number.isSafeInteger(maxSessions) || maxSessions <= 0) {
    throw new Error('Session capacity must be a positive safe integer');
  }

  const activeSessions = await store.getActiveSessionCount();
  if (activeSessions >= maxSessions) {
    return { ok: false, error: { code: ApplicationErrorCode.SESSION_LIMIT_EXCEEDED } };
  }

  const identity = parseSessionIdentityRecord(await store.createSession());
  if (!identity) {
    return {
      ok: false,
      error: {
        code: ApplicationErrorCode.INTERNAL_ERROR,
        details: { details: 'Session store returned incomplete identity authority' },
      },
    };
  }
  return { ok: true, value: identity };
}
