import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/domain/session/capability';
import type { SessionIdentityRecord, SessionVotingRecord } from '@stark-ballot/domain/types/sessionRecords';
import { asSessionId, type SessionId } from '@stark-ballot/domain/types/identifiers';
import { getApiErrorCode, readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import {
  requireSessionCapability,
  validateSessionById,
  validateSessionCapabilityForSession,
  type SessionValidationStore,
} from './session';
import { localRuntimeProfile } from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';

const runtimeProfile = localRuntimeProfile();
const SESSION_1 = asSessionId('session-1');
const SESSION_2 = asSessionId('session-2');

describe('session middleware', () => {
  const capabilitySecret = 'test-session-capability-secret-0123456789abcdef';
  let identity: SessionIdentityRecord;
  let voting: SessionVotingRecord;
  let getSessionIdentity: ReturnType<typeof vi.fn<(sessionId: SessionId) => Promise<SessionIdentityRecord | null>>>;
  let getVotingRecord: ReturnType<typeof vi.fn<(sessionId: SessionId) => Promise<SessionVotingRecord | null>>>;
  let touchSession: ReturnType<typeof vi.fn<(sessionId: SessionId) => Promise<void>>>;
  let store: SessionValidationStore;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env['SESSION_CAPABILITY_SECRET'] = capabilitySecret;
    const nowMs = Date.now();
    identity = {
      sessionId: SESSION_1,
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: `0x${'1'.repeat(64)}`,
      electionConfig: {
        totalExpected: 1,
        choices: ['A'],
        version: '1',
        botCount: 0,
        merkleTreeDepth: 1,
      },
      logId: `0x${'2'.repeat(64)}`,
      createdAtMs: nowMs,
    };
    voting = {
      sessionId: SESSION_1,
      votes: new Map(),
      bulletin: new SimpleBulletinBoard(identity.logId),
      bulletinRootHistory: [],
      botCount: 0,
      userParticipation: { status: 'not_cast' },
      lastActivityMs: nowMs,
    };
    getSessionIdentity = vi.fn(() => Promise.resolve(identity));
    getVotingRecord = vi.fn(() => Promise.resolve(voting));
    touchSession = vi.fn(() => Promise.resolve());
    store = {
      getSessionIdentity,
      getVotingRecord,
      getCurrentFinalizationRecord: () => Promise.resolve(null),
      touchSession,
    };
  });

  it('requires the capability credential', async () => {
    const result = requireSessionCapability(new Headers());
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      expect(getApiErrorCode(await readJsonRecord(result))).toBe(ErrorCode.SESSION_CAPABILITY_REQUIRED);
    }
  });

  it('binds a capability token to the exact path session', async () => {
    const token = createSessionCapabilityToken(
      { sessionId: SESSION_1, nowMs: Date.now(), ttlSeconds: 300 },
      capabilitySecret,
    );
    const headers = new Headers({ [SESSION_CAPABILITY_HEADER]: token });

    expect(validateSessionCapabilityForSession(runtimeProfile, headers, SESSION_1)).not.toBeInstanceOf(Response);
    const mismatch = validateSessionCapabilityForSession(runtimeProfile, headers, SESSION_2);
    expect(mismatch).toBeInstanceOf(Response);
    if (mismatch instanceof Response) {
      expect(getApiErrorCode(await readJsonRecord(mismatch))).toBe(ErrorCode.SESSION_CAPABILITY_INVALID);
    }
  });

  it('loads the path-selected session and updates activity by default', async () => {
    const result = await validateSessionById(SESSION_1, store);

    expect(result).toEqual({
      session: { identity, voting, finalization: null },
      sessionId: 'session-1',
    });
    expect(getSessionIdentity).toHaveBeenCalledWith('session-1');
    expect(getVotingRecord).toHaveBeenCalledWith('session-1');
    expect(touchSession).toHaveBeenCalledWith('session-1');
  });

  it('can read without updating activity', async () => {
    const result = await validateSessionById(SESSION_1, store, { updateActivity: false });

    expect(result).toEqual({
      session: { identity, voting, finalization: null },
      sessionId: 'session-1',
    });
    expect(touchSession).not.toHaveBeenCalled();
  });

  it('fails closed for missing or cross-session records', async () => {
    getSessionIdentity.mockResolvedValueOnce(null);
    const missing = await validateSessionById(SESSION_1, store);
    expect(missing).toBeInstanceOf(Response);
    if (missing instanceof Response) {
      expect(getApiErrorCode(await readJsonRecord(missing))).toBe(ErrorCode.SESSION_NOT_FOUND);
    }

    voting.sessionId = SESSION_2;
    const mismatched = await validateSessionById(SESSION_1, store);
    expect(mismatched).toBeInstanceOf(Response);
    expect(touchSession).not.toHaveBeenCalled();
  });
});
