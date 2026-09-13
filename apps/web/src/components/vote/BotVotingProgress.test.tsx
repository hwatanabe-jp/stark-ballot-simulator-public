import { act, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { BotVotingProgress } from './BotVotingProgress';
import { t as translate, type TranslationKey, type TranslationParams } from '@stark-ballot/web/i18n';
import { getProgress } from '@stark-ballot/web/api/progress';
import { ApiClientError } from '@stark-ballot/web/api/client';

const { mockPush, mockGetSessionData, mockGetSessionDataForIdentity, mockIsSessionReplacedForIdentity } = vi.hoisted(
  () => ({
    mockPush: vi.fn(),
    mockGetSessionData: vi.fn(() => ({ sessionId: 'test-session-id', capabilityToken: 'test-capability-token' })),
    mockGetSessionDataForIdentity: vi.fn<() => { sessionId: string; capabilityToken: string } | null>(() => ({
      sessionId: 'test-session-id',
      capabilityToken: 'test-capability-token',
    })),
    mockIsSessionReplacedForIdentity: vi.fn(() => false),
  }),
);

vi.mock('@stark-ballot/web/navigation/appNavigation', () => ({
  useAppRouter: () => ({
    push: mockPush,
  }),
}));

vi.mock('@stark-ballot/web/hooks', () => ({
  useTranslation: () => ({
    language: 'en',
    t: (key: TranslationKey, params?: TranslationParams) => translate('en', key, params),
  }),
}));

vi.mock('@stark-ballot/web/session', () => ({
  captureSessionIdentity: vi.fn((session?: { sessionId?: string; capabilityToken?: string } | null) =>
    session?.sessionId ? { sessionId: session.sessionId, capabilityToken: session.capabilityToken } : null,
  ),
  getSessionData: mockGetSessionData,
  getSessionDataForIdentity: mockGetSessionDataForIdentity,
  isSessionReplacedForIdentity: mockIsSessionReplacedForIdentity,
  SESSION_STORAGE_KEY: 'starkBallotSession',
}));

vi.mock('@stark-ballot/web/knowledge', () => ({
  saveKnowledgeData: vi.fn(),
}));

vi.mock('@stark-ballot/web/api/progress', () => ({
  getProgress: vi.fn(),
}));

describe('BotVotingProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.clearAllMocks();
    mockGetSessionData.mockReturnValue({ sessionId: 'test-session-id', capabilityToken: 'test-capability-token' });
    mockGetSessionDataForIdentity.mockReturnValue({
      sessionId: 'test-session-id',
      capabilityToken: 'test-capability-token',
    });
    mockIsSessionReplacedForIdentity.mockReturnValue(false);
    vi.mocked(getProgress).mockResolvedValue({
      count: 0,
      total: 63,
      completed: false,
      userVoted: true,
      finalized: false,
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps waiting for actual completion after time has passed', async () => {
    await act(async () => {
      render(<BotVotingProgress autoNavigate={true} />);
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Processing...');
    expect(getProgress).toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('navigates once as soon as the API reports completion', async () => {
    vi.mocked(getProgress).mockResolvedValue({
      count: 63,
      total: 63,
      completed: true,
      userVoted: true,
      finalized: false,
    });
    const onComplete = vi.fn();
    await act(async () => {
      render(<BotVotingProgress onComplete={onComplete} />);
    });
    expect(onComplete).toHaveBeenCalledOnce();
    expect(mockPush).toHaveBeenCalledWith('/aggregate');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(getProgress).toHaveBeenCalledOnce();
    expect(mockPush).toHaveBeenCalledOnce();
  });

  it('does not navigate for a response arriving after unmount', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof getProgress>>>();
    vi.mocked(getProgress).mockReturnValue(pending.promise);
    const onComplete = vi.fn();
    const { unmount } = render(<BotVotingProgress onComplete={onComplete} />);
    const requestSignal = vi.mocked(getProgress).mock.calls[0]?.[1]?.signal;
    unmount();
    expect(requestSignal?.aborted).toBe(true);
    await act(async () => {
      pending.resolve({ count: 63, total: 63, completed: true, userVoted: true, finalized: false });
      await pending.promise;
    });
    expect(onComplete).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('waits for an outstanding progress request before polling again', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof getProgress>>>();
    vi.mocked(getProgress).mockReturnValueOnce(pending.promise);
    const onComplete = vi.fn();
    render(<BotVotingProgress onComplete={onComplete} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(getProgress).toHaveBeenCalledOnce();

    await act(async () => {
      pending.resolve({ count: 63, total: 63, completed: true, userVoted: true, finalized: false });
      await pending.promise;
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(getProgress).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(mockPush).toHaveBeenCalledOnce();
  });

  it('rejects completed progress for a session replaced while the request was pending', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof getProgress>>>();
    vi.mocked(getProgress).mockReturnValue(pending.promise);
    const onComplete = vi.fn();
    render(<BotVotingProgress onComplete={onComplete} />);
    mockGetSessionDataForIdentity.mockReturnValue(null);
    mockIsSessionReplacedForIdentity.mockReturnValue(true);
    await act(async () => {
      pending.resolve({ count: 63, total: 63, completed: true, userVoted: true, finalized: false });
      await pending.promise;
    });
    expect(onComplete).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(
      screen.getByText('This session was replaced in another tab. Please restart from the home page.'),
    ).toBeInTheDocument();
  });

  it('fails closed when the expected session is replaced in the same tab', () => {
    render(<BotVotingProgress autoNavigate={true} />);

    mockGetSessionDataForIdentity.mockReturnValue(null);
    mockIsSessionReplacedForIdentity.mockReturnValue(true);

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'starkBallotSession',
          oldValue: JSON.stringify({ sessionId: 'test-session-id' }),
          newValue: JSON.stringify({ sessionId: 'other-session' }),
        }),
      );
    });

    expect(
      screen.getByText('This session was replaced in another tab. Please restart from the home page.'),
    ).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(mockPush).not.toHaveBeenCalled();
  });

  it('stops polling and shows a session error when progress reports session loss', async () => {
    vi.mocked(getProgress).mockRejectedValue(
      new ApiClientError('missing', 404, {
        error: {
          code: 'SESSION_NOT_FOUND',
          message: 'Session not found',
        },
        meta: { requestId: 'request-id' },
      }),
    );

    await act(async () => {
      render(<BotVotingProgress autoNavigate={true} />);
      await Promise.resolve();
    });

    expect(screen.getByText('Session not found')).toBeInTheDocument();

    expect(getProgress).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(getProgress).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
  });
});
