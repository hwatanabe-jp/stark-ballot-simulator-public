import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import HomePage from './page';
import { useRouter } from 'next/navigation';

// Mock Next.js navigation
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
}));

// Mock hooks
vi.mock('@/lib/hooks', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'pages.home.welcome': 'STARK Ballot Simulatorへようこそ',
        'pages.home.description': 'STARK証明による検証可能投票の教育デモ',
        'common.start': '開始',
        'common.loading': '読み込み中...',
        'errors.generic': '予期しないエラーが発生しました',
        'errors.sessionLimitExceeded': '現在混雑しています。しばらくしてからお試しください',
        'errors.captchaFailed': 'セキュリティチェックに失敗しました',
      };
      return translations[key] || key;
    },
  }),
}));

vi.mock('@/components/security/TurnstileWidget', () => ({
  TurnstileWidget: ({ onTokenChange }: { onTokenChange: (token: string | null) => void }) => (
    <button type="button" onClick={() => onTokenChange('test-turnstile-token')}>
      mock-turnstile
    </button>
  ),
}));

// Mock session management
vi.mock('@/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session')>();
  return {
    ...actual,
    generateSessionId: vi.fn(),
    getSessionData: vi.fn(() => null),
    isSessionReplaced: vi.fn(() => false),
    saveSessionData: vi.fn(),
  };
});

const sessionModule = await import('@/lib/session');
const mockGenerateSessionId = vi.mocked(sessionModule.generateSessionId);
const mockSaveSessionData = vi.mocked(sessionModule.saveSessionData);

describe('HomePage', () => {
  const mockPush = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NEXT_PUBLIC_SESSION_CREATE_TURNSTILE_REQUIRED;
    const mockRouter: ReturnType<typeof useRouter> = {
      push: mockPush,
      replace: vi.fn(),
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    };
    vi.mocked(useRouter).mockReturnValue(mockRouter);

    // Mock fetch globally
    global.fetch = vi.fn();
  });

  it('should render welcome message and description', () => {
    mockGenerateSessionId.mockClear();
    mockSaveSessionData.mockClear();

    render(<HomePage />);

    expect(screen.getByText('STARK Ballot Simulatorへようこそ')).toBeInTheDocument();
    expect(screen.getByText('STARK証明による検証可能投票の教育デモ')).toBeInTheDocument();
  });

  it('should render start button', () => {
    render(<HomePage />);

    const button = screen.getByRole('button', { name: '開始' });
    expect(button).toBeInTheDocument();
  });

  it('should navigate to vote page when start button is clicked', async () => {
    const user = userEvent.setup();

    // Mock successful session creation with all required fields
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            sessionId: 'test-session-123',
            capabilityToken: 'v1.test.capability',
            contractGeneration: '2026-04-zkvm-current-v1',
            electionId: '550e8400-e29b-41d4-a716-446655440000',
            electionConfigHash: '0x' + '1'.repeat(64),
            logId: 'test-log-id',
          },
        }),
    } as Response);

    render(<HomePage />);

    const button = screen.getByRole('button', { name: '開始' });
    await user.click(button);

    // Wait for async operations
    await vi.waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/vote');
    });

    expect(mockGenerateSessionId).toHaveBeenCalledWith(
      'test-session-123',
      'v1.test.capability',
      '2026-04-zkvm-current-v1',
    );
    expect(mockSaveSessionData).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'test-session-123',
        contractGeneration: '2026-04-zkvm-current-v1',
        electionId: '550e8400-e29b-41d4-a716-446655440000',
      }),
    );
  });

  it('should keep start button disabled after successful session creation', async () => {
    const user = userEvent.setup();

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            sessionId: 'test-session-123',
            capabilityToken: 'v1.test.capability',
            contractGeneration: '2026-04-zkvm-current-v1',
            electionId: '550e8400-e29b-41d4-a716-446655440000',
            electionConfigHash: '0x' + '1'.repeat(64),
            logId: 'test-log-id',
          },
        }),
    } as Response);

    render(<HomePage />);

    const button = screen.getByRole('button', { name: '開始' });
    await user.click(button);

    await vi.waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/vote');
    });

    const loadingButton = screen.getByRole('button', { name: '読み込み中...' });
    expect(loadingButton).toBeDisabled();
  });

  it('should not log session details when navigating to vote', async () => {
    const user = userEvent.setup();
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            sessionId: 'test-session-123',
            capabilityToken: 'v1.test.capability',
            contractGeneration: '2026-04-zkvm-current-v1',
            electionId: '550e8400-e29b-41d4-a716-446655440000',
            electionConfigHash: '0x' + '1'.repeat(64),
            logId: 'test-log-id',
          },
        }),
    } as Response);

    render(<HomePage />);

    await user.click(screen.getByRole('button', { name: '開始' }));

    await vi.waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/vote');
    });

    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('should not clear localStorage on mount', () => {
    const clearMock = vi.fn();
    Object.defineProperty(window, 'localStorage', {
      value: {
        clear: clearMock,
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        length: 0,
        key: vi.fn(),
      },
      writable: true,
      configurable: true,
    });

    render(<HomePage />);

    expect(clearMock).not.toHaveBeenCalled();
  });

  it('should have proper semantic structure', () => {
    render(<HomePage />);

    // Should have heading
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toBeInTheDocument();

    // Should have description paragraph
    const description = screen.getByText('STARK証明による検証可能投票の教育デモ');
    expect(description.tagName).toBe('P');
  });

  it('should display error when session limit is exceeded', async () => {
    const user = userEvent.setup();

    // Mock session limit exceeded error
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'SESSION_LIMIT_EXCEEDED' }),
    } as Response);

    render(<HomePage />);

    const button = screen.getByRole('button', { name: '開始' });
    await user.click(button);

    // Wait for error message
    await vi.waitFor(() => {
      expect(screen.getByText('現在混雑しています。しばらくしてからお試しください')).toBeInTheDocument();
    });

    // Should not navigate
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('should display loading state while creating session', async () => {
    const user = userEvent.setup();

    // Mock delayed response with all required fields
    vi.mocked(global.fetch).mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: true,
                json: () =>
                  Promise.resolve({
                    data: {
                      sessionId: 'test-session-123',
                      capabilityToken: 'v1.test.capability',
                      contractGeneration: '2026-04-zkvm-current-v1',
                      electionId: '550e8400-e29b-41d4-a716-446655440000',
                      electionConfigHash: '0x' + '1'.repeat(64),
                      logId: 'test-log-id',
                    },
                  }),
              } as Response),
            100,
          ),
        ),
    );

    render(<HomePage />);

    const button = screen.getByRole('button', { name: '開始' });
    await user.click(button);

    // Should show loading state
    expect(screen.getByRole('button', { name: '読み込み中...' })).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('should clear session-create turnstile token when CAPTCHA_FAILED is returned', async () => {
    process.env.NEXT_PUBLIC_SESSION_CREATE_TURNSTILE_REQUIRED = '1';
    const user = userEvent.setup();

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'CAPTCHA_FAILED' }),
    } as Response);

    render(<HomePage />);

    await user.click(screen.getByRole('button', { name: 'mock-turnstile' }));
    const startButton = screen.getByRole('button', { name: '開始' });
    expect(startButton).toBeEnabled();

    await user.click(startButton);

    await vi.waitFor(() => {
      expect(screen.getByText('セキュリティチェックに失敗しました')).toBeInTheDocument();
    });
    expect(startButton).toBeDisabled();
  });
});
