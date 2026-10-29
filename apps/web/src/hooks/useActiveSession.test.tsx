import { admitSessionIdentity } from '@stark-ballot/web/session/identity';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, initializeSession } from '@stark-ballot/web/session';
import { SESSION_STORAGE_KEY } from '@stark-ballot/web/session/storage';
import { useHasActiveSession } from './useActiveSession';

const session = {
  ...admitSessionIdentity({ sessionId: 'active-session-test', capabilityToken: 'active-session-test-capability' }),
  electionId: '123e4567-e89b-42d3-a456-426614174000',
  electionConfigHash: `0x${'a'.repeat(64)}`,
  logId: `0x${'b'.repeat(64)}`,
};

describe('useHasActiveSession', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => vi.restoreAllMocks());

  it('updates mounted consumers after creating and clearing a session in the same tab', async () => {
    const { result } = renderHook(() => useHasActiveSession());
    expect(result.current).toBe(false);

    await act(async () => {
      initializeSession(session);
    });
    expect(result.current).toBe(true);

    await act(async () => {
      clearSession();
    });
    expect(result.current).toBe(false);
  });

  it('refreshes when another tab removes the session or clears storage', async () => {
    const { result } = renderHook(() => useHasActiveSession());
    await act(async () => {
      initializeSession(session);
    });
    expect(result.current).toBe(true);
    act(() => {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: SESSION_STORAGE_KEY }));
    });
    expect(result.current).toBe(false);

    await act(async () => {
      initializeSession(session);
    });
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(result.current).toBe(false);
  });

  it('keeps the configured safe fallback when storage is inaccessible', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Storage denied');
    });
    const { result } = renderHook(() => useHasActiveSession({ fallback: true }));
    expect(result.current).toBe(true);
  });
});
