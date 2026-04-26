import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { FinalizationStatusFinalizationResult } from '@/lib/finalize/finalization-status-client';
import type { SessionData } from '@/lib/session/types';
import { useFinalizationPolling } from './useFinalizationPolling';

vi.mock('@/lib/session', () => ({
  clearSessionData: vi.fn(),
  getSessionAuthHeaders: vi.fn(() => ({ 'X-Session-ID': 'session-1' })),
  getSessionData: vi.fn(),
  saveSessionData: vi.fn(),
}));

vi.mock('@/lib/api/apiBaseUrl', () => ({
  resolveApiUrl: (path: string) => path,
}));

vi.mock('@/lib/api/apiFetch', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/lib/knowledge', () => ({
  clearKnowledge: vi.fn(),
  clearKnowledgeForSession: vi.fn(),
}));

vi.mock('@/lib/finalize/finalization-status-client', () => ({
  fetchFinalizationStatus: vi.fn(),
  FinalizationStatusError: class FinalizationStatusError extends Error {
    status: number;
    responseBody?: unknown;

    constructor(message: string, status: number, responseBody?: unknown) {
      super(message);
      this.status = status;
      this.responseBody = responseBody;
    }
  },
  resolveFinalizationStatusErrorCode: (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'responseBody' in error &&
    typeof error.responseBody === 'object' &&
    error.responseBody !== null &&
    'error' in error.responseBody &&
    typeof error.responseBody.error === 'string'
      ? error.responseBody.error
      : null,
}));

const sessionModule = await import('@/lib/session');
const statusModule = await import('@/lib/finalize/finalization-status-client');

const mockClearSessionData = vi.mocked(sessionModule.clearSessionData);
const mockGetSessionData = vi.mocked(sessionModule.getSessionData);
const mockFetchFinalizationStatus = vi.mocked(statusModule.fetchFinalizationStatus);

describe('useFinalizationPolling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionData.mockReturnValue({
      sessionId: 'session-1',
      capabilityToken: 'capability-token',
      lastActivity: Date.now(),
      finalizeResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
      } as unknown as NonNullable<SessionData['finalizeResult']>,
    });
  });

  it('fails closed when a terminal success state cannot restore a canonical finalization snapshot', async () => {
    mockFetchFinalizationStatus.mockResolvedValue({
      sessionId: 'session-1',
      finalizationState: {
        status: 'succeeded',
        executionId: 'exec-1234567890',
        queuedAt: Date.now(),
        startedAt: Date.now(),
        completedAt: Date.now(),
      },
      queue: null,
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        imageId: '0x' + '1'.repeat(64),
      } as unknown as NonNullable<FinalizationStatusFinalizationResult>,
      stepFunctions: null,
    });

    const triggerFetch = vi.fn();
    const setLoading = vi.fn();

    const { result } = renderHook(() =>
      useFinalizationPolling({
        t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
        triggerFetch,
        setLoading,
      }),
    );

    await waitFor(() => {
      expect(result.current.statusVariant).toBe('error');
    });

    expect(result.current.statusMessage).toContain('UNSUPPORTED_RESULT');
    expect(triggerFetch).not.toHaveBeenCalled();
    expect(setLoading).toHaveBeenCalledWith(false);
  });

  it('stops polling when status returns a fail-closed artifact state', async () => {
    mockFetchFinalizationStatus.mockResolvedValueOnce({
      sessionId: 'session-1',
      artifactState: 'unsupported_current_artifact',
      finalizationState: {
        status: 'failed',
        executionId: 'exec-stale',
        queuedAt: Date.now(),
        failedAt: Date.now(),
        error: {
          code: 'UNSUPPORTED_CURRENT_ARTIFACT',
          message: 'Unsupported current artifact',
        },
      },
      queue: null,
      finalizationResult: null,
      stepFunctions: null,
    });

    const triggerFetch = vi.fn();
    const setLoading = vi.fn();

    const { result } = renderHook(() =>
      useFinalizationPolling({
        t: (key) => key,
        triggerFetch,
        setLoading,
      }),
    );

    await waitFor(() => {
      expect(result.current.statusVariant).toBe('error');
    });

    expect(result.current.statusMessage).toBe('Unsupported current artifact');
    expect(triggerFetch).not.toHaveBeenCalled();
    expect(setLoading).toHaveBeenCalledWith(false);
    expect(mockClearSessionData).not.toHaveBeenCalled();
  });

  it('treats SESSION_NOT_FOUND as a session error instead of async-disabled mode', async () => {
    mockFetchFinalizationStatus.mockRejectedValueOnce(
      new statusModule.FinalizationStatusError('missing', 404, {
        error: 'SESSION_NOT_FOUND',
        message: 'Session not found',
      }),
    );

    const triggerFetch = vi.fn();
    const setLoading = vi.fn();
    const onMissingSession = vi.fn();

    const { result } = renderHook(() =>
      useFinalizationPolling({
        t: (key) => key,
        triggerFetch,
        setLoading,
        onMissingSession,
      }),
    );

    await waitFor(() => {
      expect(result.current.statusVariant).toBe('error');
    });

    expect(result.current.statusMessage).toBe('pages.verify.sessionError');
    expect(triggerFetch).not.toHaveBeenCalled();
    expect(onMissingSession).toHaveBeenCalledTimes(1);
    expect(setLoading).toHaveBeenCalledWith(false);
    expect(mockClearSessionData).toHaveBeenCalledTimes(1);
  });
});
