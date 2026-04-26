import { act, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { BotVotingProgress } from './BotVotingProgress';
import { t as translate } from '@/lib/i18n';

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

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

vi.mock('@/lib/hooks', () => ({
  useTranslation: () => ({
    language: 'en',
    t: (key: string, params?: Record<string, string | number>) => translate('en', key, params),
  }),
}));

vi.mock('@/lib/session', () => ({
  captureSessionIdentity: vi.fn((session?: { sessionId?: string; capabilityToken?: string } | null) =>
    session?.sessionId ? { sessionId: session.sessionId, capabilityToken: session.capabilityToken } : null,
  ),
  getSessionData: mockGetSessionData,
  getSessionDataForIdentity: mockGetSessionDataForIdentity,
  getSessionAuthHeaders: vi.fn(() => ({
    'X-Session-ID': 'test-session-id',
    'X-Session-Capability': 'test-capability-token',
  })),
  isSessionReplacedForIdentity: mockIsSessionReplacedForIdentity,
  SESSION_STORAGE_KEY: 'starkBallotSession',
}));

vi.mock('@/lib/knowledge', () => ({
  saveKnowledgeData: vi.fn(),
}));

const mockApiFetch = vi.fn<
  (input?: unknown, init?: unknown) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>
>(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ data: { count: 0, total: 63 } }),
  }),
);

vi.mock('@/lib/api/apiFetch', () => ({
  apiFetch: (...args: Parameters<typeof mockApiFetch>) => mockApiFetch(...args),
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
    mockApiFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { count: 0, total: 63 } }),
      }),
    );
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('shows the bot voting title and processing text', () => {
    render(<BotVotingProgress autoNavigate={false} />);

    expect(screen.getByText(/bots are voting/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Processing/i).length).toBeGreaterThan(0);
  });

  it('freezes bar heights after the 10 second animation window', () => {
    render(<BotVotingProgress autoNavigate={false} />);

    const getBarHeight = (label: string) => {
      const labelNode = screen.getByText(label);
      const column = labelNode.parentElement;
      if (!column) {
        throw new Error(`Missing column for label ${label}`);
      }
      const bar = column.querySelector<HTMLDivElement>('div[style]');
      if (!bar) {
        throw new Error(`Missing bar for label ${label}`);
      }
      return bar.style.height;
    };

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    const heightAtEndA = getBarHeight('A');
    const heightAtEndB = getBarHeight('B');

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(getBarHeight('A')).toBe(heightAtEndA);
    expect(getBarHeight('B')).toBe(heightAtEndB);
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
    mockApiFetch.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'SESSION_NOT_FOUND' }),
      }),
    );

    await act(async () => {
      render(<BotVotingProgress autoNavigate={true} />);
      await Promise.resolve();
    });

    expect(screen.getByText('Session not found')).toBeInTheDocument();

    expect(mockApiFetch).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
  });
});
