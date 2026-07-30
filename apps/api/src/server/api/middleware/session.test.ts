import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  requireSessionCapability,
  requireSessionId,
  validateFinalizedSession,
  validateSessionCapabilityForSession,
  validateSession,
  validateSessionWithCapability,
  validateSessionWithVote,
} from './session';
import type { SessionStoreUpdate, VoteStore } from '@stark-ballot/domain/types/voteStore';
import type { SessionData } from '@stark-ballot/domain/types/server';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { getStringProperty } from '@stark-ballot/domain/utils/guards';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/domain/session/capability';
import { resolveCurrentContractGeneration } from '@stark-ballot/domain/contract';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

describe('session middleware', () => {
  let mockStore: VoteStore;
  let mockSession: SessionData;
  let getSessionImpl: (sessionId: string) => Promise<SessionData | null>;
  let updateSessionCalls: Array<[string, SessionStoreUpdate | undefined]>;
  const capabilitySecret = 'test-session-capability-secret-0123456789abcdef';

  beforeEach(() => {
    vi.clearAllMocks();
    process.env['SESSION_CAPABILITY_SECRET'] = capabilitySecret;

    mockSession = {
      sessionId: 'test-session-123',
      contractGeneration: resolveCurrentContractGeneration(),
      votes: new Map(),
      botCount: 0,
      finalized: false,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      ...omitUndefinedProperties({ userVoteIndex: undefined }),
    };

    getSessionImpl = () => Promise.resolve(mockSession);
    updateSessionCalls = [];
    const store = {
      createSession: () => Promise.resolve(mockSession),
      getSession: (sessionId: string) => getSessionImpl(sessionId),
      addVote: () => Promise.resolve({ leafIndex: 0, merklePath: [], bulletinRootAtCast: `0x${'0'.repeat(64)}` }),
      addBotVotes: () => Promise.resolve(undefined),
      updateSession: (sessionId: string, data?: SessionStoreUpdate) => {
        updateSessionCalls.push([sessionId, data]);
        return Promise.resolve(undefined);
      },
      recordVerificationObservation: () => Promise.resolve({ status: 'recorded' }),
      getActiveSessionCount: () => Promise.resolve(0),
      getVoteById: () => Promise.resolve(null),
      getVoteByIdWithProof: () => Promise.resolve(null),
      getVoteProof: () => Promise.resolve(null),
    } satisfies VoteStore;
    mockStore = store;
  });

  describe('validateSession', () => {
    it('should return error if session ID is missing', async () => {
      const headers = new Headers();

      const result = await validateSession(headers, mockStore);

      expect(result).toBeInstanceOf(Response);
      if (result instanceof Response) {
        const data = await readJsonRecord(result, 'session auth missing id');
        expect(getStringProperty(data, 'error')).toBe(ErrorCode.SESSION_ID_REQUIRED);
      }
    });

    it('should return error if session not found', async () => {
      getSessionImpl = () => Promise.resolve(null);
      const headers = new Headers({ 'X-Session-ID': 'test-session-123' });

      const result = await validateSession(headers, mockStore);

      expect(result).toBeInstanceOf(Response);
      if (result instanceof Response) {
        const data = await readJsonRecord(result, 'session auth not found');
        expect(getStringProperty(data, 'error')).toBe(ErrorCode.SESSION_NOT_FOUND);
      }
    });

    it('should return session data if valid', async () => {
      const headers = new Headers({ 'X-Session-ID': 'test-session-123' });

      const result = await validateSession(headers, mockStore);

      expect(result).not.toBeInstanceOf(Response);
      if (!(result instanceof Response)) {
        expect(result.session).toBe(mockSession);
        expect(result.sessionId).toBe('test-session-123');
      }
      expect(updateSessionCalls).toEqual([['test-session-123', undefined]]);
    });

    it('fails closed for stale live sessions before refreshing activity', async () => {
      mockSession.contractGeneration = 'stale-contract-generation';
      const headers = new Headers({ 'X-Session-ID': 'test-session-123' });

      const result = await validateSession(headers, mockStore);

      expect(result).toBeInstanceOf(Response);
      if (result instanceof Response) {
        const data = await readJsonRecord(result, 'stale live session');
        expect(getStringProperty(data, 'error')).toBe(ErrorCode.SESSION_NOT_FOUND);
      }
      expect(updateSessionCalls).toEqual([]);
    });
  });

  describe('requireSessionCapability', () => {
    it('returns error when capability token is missing', async () => {
      const headers = new Headers({ 'X-Session-ID': 'test-session-123' });

      const result = requireSessionCapability(headers);

      expect(result).toBeInstanceOf(Response);
      if (result instanceof Response) {
        const data = await readJsonRecord(result, 'session capability missing');
        expect(getStringProperty(data, 'error')).toBe(ErrorCode.SESSION_CAPABILITY_REQUIRED);
      }
    });
  });

  describe('validateSessionCapabilityForSession', () => {
    it('returns invalid error for tampered token', async () => {
      const validToken = createSessionCapabilityToken(
        {
          sessionId: 'test-session-123',
          nowMs: 1_700_000_000_000,
          ttlSeconds: 300,
          nonce: 'nonce',
        },
        capabilitySecret,
      );
      const headers = new Headers({
        'X-Session-ID': 'test-session-123',
        [SESSION_CAPABILITY_HEADER]: `${validToken}tampered`,
      });

      const result = validateSessionCapabilityForSession(headers, 'test-session-123');

      expect(result).toBeInstanceOf(Response);
      if (result instanceof Response) {
        const data = await readJsonRecord(result, 'session capability invalid');
        expect(getStringProperty(data, 'error')).toBe(ErrorCode.SESSION_CAPABILITY_INVALID);
      }
    });
  });

  describe('requireSessionId', () => {
    it('should return error if session ID is missing', async () => {
      // Given
      const headers = new Headers();

      // When
      const result = requireSessionId(headers);

      // Then
      expect(result).toBeInstanceOf(Response);
      if (result instanceof Response) {
        const data = await readJsonRecord(result, 'session id missing');
        expect(getStringProperty(data, 'error')).toBe(ErrorCode.SESSION_ID_REQUIRED);
      }
    });

    it('should return session ID when present', () => {
      // Given
      const headers = new Headers({ 'X-Session-ID': 'session-abc' });

      // When
      const result = requireSessionId(headers);

      // Then
      expect(result).toBe('session-abc');
    });
  });

  describe('validateSessionWithVote', () => {
    it('should return error if user has not voted', async () => {
      const headers = new Headers({ 'X-Session-ID': 'test-session-123' });

      const result = await validateSessionWithVote(headers, mockStore);

      expect(result).toBeInstanceOf(Response);
      if (result instanceof Response) {
        const data = await readJsonRecord(result, 'session auth user not voted');
        expect(getStringProperty(data, 'error')).toBe(ErrorCode.USER_NOT_VOTED);
      }
    });

    it('should return session data if user has voted', async () => {
      mockSession.userVoteIndex = 0;
      const headers = new Headers({ 'X-Session-ID': 'test-session-123' });

      const result = await validateSessionWithVote(headers, mockStore);

      expect(result).not.toBeInstanceOf(Response);
      if (!(result instanceof Response)) {
        expect(result.session).toBe(mockSession);
        expect(result.sessionId).toBe('test-session-123');
      }
    });
  });

  describe('validateSessionWithCapability', () => {
    it('returns session data when id/token/session are valid', async () => {
      const token = createSessionCapabilityToken(
        {
          sessionId: 'test-session-123',
          nowMs: Date.now(),
          ttlSeconds: 300,
        },
        capabilitySecret,
      );
      const headers = new Headers({
        'X-Session-ID': 'test-session-123',
        [SESSION_CAPABILITY_HEADER]: token,
      });

      const result = await validateSessionWithCapability(headers, mockStore, { updateActivity: false });

      expect(result).not.toBeInstanceOf(Response);
      if (!(result instanceof Response)) {
        expect(result.sessionId).toBe('test-session-123');
      }
    });
  });

  describe('validateFinalizedSession', () => {
    it('should return error if session not finalized', async () => {
      const headers = new Headers({ 'X-Session-ID': 'test-session-123' });

      const result = await validateFinalizedSession(headers, mockStore);

      expect(result).toBeInstanceOf(Response);
      if (result instanceof Response) {
        const data = await readJsonRecord(result, 'session auth not finalized');
        expect(getStringProperty(data, 'error')).toBe(ErrorCode.SESSION_NOT_FINALIZED);
      }
    });

    it('should return session data if finalized', async () => {
      mockSession.finalized = true;
      const headers = new Headers({ 'X-Session-ID': 'test-session-123' });

      const result = await validateFinalizedSession(headers, mockStore);

      expect(result).not.toBeInstanceOf(Response);
      if (!(result instanceof Response)) {
        expect(result.session).toBe(mockSession);
        expect(result.sessionId).toBe('test-session-123');
      }
    });
  });
});
