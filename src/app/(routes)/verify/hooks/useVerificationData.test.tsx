import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { MutableRefObject } from 'react';
import type { SessionIdentity } from '@/lib/session';
import type { SessionData } from '@/lib/session/types';
import { resolveCanonicalFinalizationPayload } from '@/lib/finalize/client-finalization-result';
import { useVerificationData } from './useVerificationData';
import { createTestJournal } from '@/lib/testing/test-helpers';

vi.mock('@/lib/session', () => ({
  getSessionAuthHeaders: vi.fn(() => ({ 'X-Session-ID': 'session-1' })),
  getSessionDataForIdentity: vi.fn(),
  isSessionReplaced: vi.fn(() => false),
  isSessionReplacedForIdentity: vi.fn(() => false),
}));

vi.mock('@/lib/knowledge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/knowledge')>();
  return {
    ...actual,
    getKnowledgeValue: vi.fn(),
    mergeKnowledgeFromApi: vi.fn(),
    saveKnowledgeData: vi.fn(),
  };
});

vi.mock('@/lib/api/apiBaseUrl', () => ({
  resolveApiUrl: (path: string) => path,
}));

vi.mock('@/lib/api/apiFetch', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/lib/finalize/client-finalization-boundary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/finalize/client-finalization-boundary')>();
  return {
    ...actual,
    clearClientFinalizedProjection: vi.fn(),
    clearClientSessionAuthority: vi.fn(),
  };
});

vi.mock('@/lib/verification/stark-verification-polling', () => ({
  getStarkVerificationSnapshot: vi.fn(),
  subscribeStarkVerificationSnapshot: vi.fn(() => () => undefined),
}));

const sessionModule = await import('@/lib/session');
const apiModule = await import('@/lib/api/apiFetch');
const boundaryModule = await import('@/lib/finalize/client-finalization-boundary');
const pollingModule = await import('@/lib/verification/stark-verification-polling');

const mockGetSessionDataForIdentity = vi.mocked(sessionModule.getSessionDataForIdentity);
const mockApiFetch = vi.mocked(apiModule.apiFetch);
const mockClearClientFinalizedProjection = vi.mocked(boundaryModule.clearClientFinalizedProjection);
const mockClearClientSessionAuthority = vi.mocked(boundaryModule.clearClientSessionAuthority);
const mockGetStarkVerificationSnapshot = vi.mocked(pollingModule.getStarkVerificationSnapshot);
const mockSubscribeStarkVerificationSnapshot = vi.mocked(pollingModule.subscribeStarkVerificationSnapshot);

const createSupportedFinalizeResult = (): NonNullable<SessionData['finalizeResult']> => {
  const journal = createTestJournal({
    totalExpected: 1,
    validVotes: 1,
    missingIndices: 0,
    invalidIndices: 0,
    seenIndicesCount: 1,
  });

  const result = resolveCanonicalFinalizationPayload({
    tally: {
      counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
      totalVotes: 1,
      tamperedCount: 0,
    },
    imageId: '0x' + 'e'.repeat(64),
    journal,
  });

  if (!result) {
    throw new Error('Failed to build canonical finalization snapshot');
  }

  return result;
};

describe('useVerificationData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockReset();
    mockSubscribeStarkVerificationSnapshot.mockImplementation(() => () => undefined);
  });

  it('ignores background STARK snapshots when browser-local finalization state is unsupported', () => {
    mockGetSessionDataForIdentity.mockReturnValue({
      sessionId: 'session-1',
      capabilityToken: 'capability-token',
      lastActivity: Date.now(),
      verificationRequestedAt: Date.now(),
      finalizeResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        imageId: '0x' + '1'.repeat(64),
      } as unknown as NonNullable<SessionData['finalizeResult']>,
    });
    mockGetStarkVerificationSnapshot.mockReturnValue({
      sessionId: 'session-1',
      status: 'success',
      payload: {
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
        },
        verificationStatus: 'success',
      },
      receivedAt: Date.now(),
    });

    const sessionIdentityRef = {
      current: {
        sessionId: 'session-1',
        capabilityToken: 'capability-token',
      },
    } as MutableRefObject<SessionIdentity | null>;

    const { result } = renderHook(() =>
      useVerificationData({
        t: (key) => key,
        sessionIdentityRef,
        initialSessionIdentity: sessionIdentityRef.current,
      }),
    );

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('hydrates from the background snapshot as provisional data while keeping loading active until server revalidation', () => {
    mockGetSessionDataForIdentity.mockReturnValue({
      sessionId: 'session-1',
      capabilityToken: 'capability-token',
      lastActivity: Date.now(),
      verificationRequestedAt: Date.now(),
      finalizeResult: createSupportedFinalizeResult(),
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      myVote: 'A',
      myRand: '0x' + 'a'.repeat(64),
    });
    mockGetStarkVerificationSnapshot.mockReturnValue({
      sessionId: 'session-1',
      status: 'success',
      payload: {
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
        },
        verificationStatus: 'success',
      },
      receivedAt: Date.now(),
    });

    const sessionIdentityRef = {
      current: {
        sessionId: 'session-1',
        capabilityToken: 'capability-token',
      },
    } as MutableRefObject<SessionIdentity | null>;

    const { result } = renderHook(() =>
      useVerificationData({
        t: (key) => key,
        sessionIdentityRef,
        initialSessionIdentity: sessionIdentityRef.current,
      }),
    );

    expect(result.current.data).not.toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.serverValidated).toBe(false);
  });

  it('ignores subscribed STARK snapshots until the server has revalidated the current finalized authority', () => {
    let listener: ((snapshot: { sessionId: string; payload: unknown; receivedAt: number }) => void) | undefined;
    mockSubscribeStarkVerificationSnapshot.mockImplementation((callback) => {
      listener = callback as typeof listener;
      return () => undefined;
    });
    mockGetSessionDataForIdentity.mockReturnValue({
      sessionId: 'session-1',
      capabilityToken: 'capability-token',
      lastActivity: Date.now(),
      verificationRequestedAt: Date.now(),
      finalizeResult: createSupportedFinalizeResult(),
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      myVote: 'A',
      myRand: '0x' + 'a'.repeat(64),
    });
    mockGetStarkVerificationSnapshot.mockReturnValue(null);

    const sessionIdentityRef = {
      current: {
        sessionId: 'session-1',
        capabilityToken: 'capability-token',
      },
    } as MutableRefObject<SessionIdentity | null>;

    const { result } = renderHook(() =>
      useVerificationData({
        t: (key) => key,
        sessionIdentityRef,
        initialSessionIdentity: sessionIdentityRef.current,
      }),
    );

    act(() => {
      listener?.({
        sessionId: 'session-1',
        payload: {
          electionId: '550e8400-e29b-41d4-a716-446655440000',
          tally: {
            counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
            totalVotes: 1,
          },
          verificationStatus: 'success',
        },
        receivedAt: Date.now(),
      });
    });

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.serverValidated).toBe(false);
  });

  it('clears browser-local finalized state when verification returns a fail-closed current-artifact payload with 200', async () => {
    mockGetSessionDataForIdentity.mockReturnValue({
      sessionId: 'session-1',
      capabilityToken: 'capability-token',
      lastActivity: Date.now(),
      verificationRequestedAt: Date.now(),
      finalizeResult: createSupportedFinalizeResult(),
    });
    mockGetStarkVerificationSnapshot.mockReturnValue(null);
    mockApiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () =>
        Promise.resolve({
          error: 'UNSUPPORTED_CURRENT_ARTIFACT',
          message: 'Finalized state is unsupported for the current contract generation',
          artifactState: 'unsupported_current_artifact',
        }),
    } as Response);

    const sessionIdentityRef = {
      current: {
        sessionId: 'session-1',
        capabilityToken: 'capability-token',
      },
    } as MutableRefObject<SessionIdentity | null>;

    const { result } = renderHook(() =>
      useVerificationData({
        t: (key) => key,
        sessionIdentityRef,
        initialSessionIdentity: sessionIdentityRef.current,
      }),
    );

    await expect(result.current.fetchVerification()).rejects.toThrow(
      'Finalized state is unsupported for the current contract generation',
    );
    expect(mockClearClientFinalizedProjection).toHaveBeenCalledWith(sessionIdentityRef.current);
  });

  it('clears browser-local finalized state when verification returns a fail-closed current-artifact error', async () => {
    mockGetSessionDataForIdentity.mockReturnValue({
      sessionId: 'session-1',
      capabilityToken: 'capability-token',
      lastActivity: Date.now(),
      verificationRequestedAt: Date.now(),
      finalizeResult: createSupportedFinalizeResult(),
    });
    mockGetStarkVerificationSnapshot.mockReturnValue(null);
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: () =>
        Promise.resolve({
          error: 'UNSUPPORTED_CURRENT_ARTIFACT',
          message: 'Finalized state is unsupported for the current contract generation',
        }),
    } as Response);

    const sessionIdentityRef = {
      current: {
        sessionId: 'session-1',
        capabilityToken: 'capability-token',
      },
    } as MutableRefObject<SessionIdentity | null>;

    const { result } = renderHook(() =>
      useVerificationData({
        t: (key) => key,
        sessionIdentityRef,
        initialSessionIdentity: sessionIdentityRef.current,
      }),
    );

    await expect(result.current.fetchVerification()).rejects.toThrow(
      'Finalized state is unsupported for the current contract generation',
    );
    expect(mockClearClientFinalizedProjection).toHaveBeenCalledWith(sessionIdentityRef.current);
  });

  it('clears client session authority when verification returns a capability-loss error', async () => {
    mockGetSessionDataForIdentity.mockReturnValue({
      sessionId: 'session-1',
      capabilityToken: 'capability-token',
      lastActivity: Date.now(),
      verificationRequestedAt: Date.now(),
      finalizeResult: createSupportedFinalizeResult(),
    });
    mockGetStarkVerificationSnapshot.mockReturnValue(null);
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: () =>
        Promise.resolve({
          error: 'SESSION_CAPABILITY_INVALID',
          message: 'Capability token is invalid',
        }),
    } as Response);

    const sessionIdentityRef = {
      current: {
        sessionId: 'session-1',
        capabilityToken: 'capability-token',
      },
    } as MutableRefObject<SessionIdentity | null>;

    const { result } = renderHook(() =>
      useVerificationData({
        t: (key) => key,
        sessionIdentityRef,
        initialSessionIdentity: sessionIdentityRef.current,
      }),
    );

    await expect(result.current.fetchVerification()).rejects.toThrow('pages.verify.sessionError');
    expect(mockClearClientSessionAuthority).toHaveBeenCalledWith(sessionIdentityRef.current);
  });

  it('clears client session authority when verification returns session not found', async () => {
    mockGetSessionDataForIdentity.mockReturnValue({
      sessionId: 'session-1',
      capabilityToken: 'capability-token',
      lastActivity: Date.now(),
      verificationRequestedAt: Date.now(),
      finalizeResult: createSupportedFinalizeResult(),
    });
    mockGetStarkVerificationSnapshot.mockReturnValue(null);
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: () =>
        Promise.resolve({
          error: 'SESSION_NOT_FOUND',
          message: 'Session not found',
        }),
    } as Response);

    const sessionIdentityRef = {
      current: {
        sessionId: 'session-1',
        capabilityToken: 'capability-token',
      },
    } as MutableRefObject<SessionIdentity | null>;

    const { result } = renderHook(() =>
      useVerificationData({
        t: (key) => key,
        sessionIdentityRef,
        initialSessionIdentity: sessionIdentityRef.current,
      }),
    );

    await expect(result.current.fetchVerification()).rejects.toThrow('pages.verify.sessionError');
    expect(mockClearClientSessionAuthority).toHaveBeenCalledWith(sessionIdentityRef.current);
  });
});
