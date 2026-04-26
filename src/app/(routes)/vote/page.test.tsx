import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import VotePage from './page';

vi.mock('@/components/security/TurnstileWidget', () => {
  return {
    TurnstileWidget: ({ onTokenChange }: { onTokenChange: (token: string | null) => void }) => {
      useEffect(() => {
        onTokenChange('test-turnstile-token');
      }, [onTokenChange]);
      return <div data-testid="turnstile-widget" />;
    },
  };
});

// Mock Next.js router
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

// Mock session management
vi.mock('@/lib/session', () => ({
  generateSessionId: vi.fn(() => 'test-session-id'),
  getSessionData: vi.fn(() => ({
    sessionId: 'test-session-id',
    capabilityToken: 'test-capability-token',
    electionId: '550e8400-e29b-41d4-a716-446655440000',
    lastActivity: Date.now(),
  })),
  getSessionAuthHeaders: vi.fn(() => ({
    'X-Session-ID': 'test-session-id',
    'X-Session-Capability': 'test-capability-token',
  })),
  captureSessionIdentity: vi.fn((session?: { sessionId: string; capabilityToken: string } | null) =>
    session
      ? {
          sessionId: session.sessionId,
          capabilityToken: session.capabilityToken,
        }
      : null,
  ),
  getSessionDataForIdentity: vi.fn(() => ({
    sessionId: 'test-session-id',
    capabilityToken: 'test-capability-token',
    electionId: '550e8400-e29b-41d4-a716-446655440000',
    lastActivity: Date.now(),
  })),
  isSessionReplacedForIdentity: vi.fn(() => false),
  saveSessionData: vi.fn(),
  updateLastActivity: vi.fn(),
  SESSION_STORAGE_KEY: 'starkBallotSession',
}));

vi.mock('@/lib/knowledge', () => ({
  saveKnowledgeData: vi.fn(),
}));

// Mock crypto commitment
vi.mock('@/lib/crypto/commitment', () => ({
  generateCommitment: vi.fn(() => ({
    commitment: 'test-commitment',
    randomValue: 'test-random',
  })),
}));

// Mock i18n
vi.mock('@/lib/hooks', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const translations: Record<string, string> = {
        'pages.vote.title': 'Vote',
        'pages.vote.overview': 'Vote Overview',
        'pages.vote.selectionTitle': 'Select your choice',
        'pages.vote.selectionLabel': 'Vote selection',
        'pages.vote.submit': 'Cast Vote',
        'pages.vote.submitting': 'Submitting...',
        'pages.vote.botVoting.title': 'Bot voting in progress...',
        'pages.vote.botVoting.processing': 'Processing...',
        'common.vote': 'Vote',
        'common.submitting': 'Submitting...',
        'errors.network': 'Network error',
        'errors.generic': 'An error occurred',
        'errors.captchaFailed': 'Security check failed',
      };
      if (key === 'pages.vote.optionLabel') {
        return `Option ${params?.option ?? ''}`.trim();
      }
      return translations[key] || key;
    },
    language: 'en',
  }),
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('VotePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    window.location.hash = '';
    mockFetch.mockImplementation((input: RequestInfo) => {
      const url = typeof input === 'string' ? input : input.url;

      if (url.includes('/api/progress')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { count: 0, total: 63 } }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              voteId: '550e8400-e29b-41d4-a716-446655440000',
              bulletinIndex: 0,
              bulletinRootAtCast: '0x' + 'a'.repeat(64),
              timestamp: 1730000000000,
            },
          }),
      });
    });
  });

  it('should render vote overview and options', () => {
    render(<VotePage />);

    // Check for overview text
    expect(screen.getByText(/投票概要|Vote Overview/i)).toBeInTheDocument();

    // Check for all vote options
    expect(screen.getByLabelText(/Option A/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Option B/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Option C/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Option D/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Option E/i)).toBeInTheDocument();
  });

  it('should disable vote button when no option is selected', () => {
    render(<VotePage />);

    const voteButton = screen.getByRole('button', { name: /投票|Vote/i });
    expect(voteButton).toBeDisabled();
  });

  it('should enable vote button when an option is selected', async () => {
    const user = userEvent.setup();
    render(<VotePage />);

    const voteButton = screen.getByRole('button', { name: /投票|Vote/i });
    const optionA = screen.getByLabelText(/Option A/i);

    // Initially disabled
    expect(voteButton).toBeDisabled();

    // Select option A
    await user.click(optionA);

    // Now enabled
    expect(voteButton).toBeEnabled();
  });

  it('should store selected option in knowledge store on selection', async () => {
    const user = userEvent.setup();
    const { saveKnowledgeData } = await import('@/lib/knowledge');
    render(<VotePage />);

    await user.click(screen.getByLabelText(/Option A/i));

    expect(saveKnowledgeData).toHaveBeenCalledWith({ 'user.choice': 'A' });
  });

  it('should allow selecting different options', async () => {
    const user = userEvent.setup();
    render(<VotePage />);

    const optionA = screen.getByLabelText(/Option A/i);
    const optionB = screen.getByLabelText(/Option B/i);

    // Select option A
    await user.click(optionA);
    expect(optionA).toBeChecked();
    expect(optionB).not.toBeChecked();

    // Switch to option B
    await user.click(optionB);
    expect(optionA).not.toBeChecked();
    expect(optionB).toBeChecked();
  });

  it('should generate commitment when vote button is clicked', async () => {
    const user = userEvent.setup();
    const { generateCommitment } = await import('@/lib/crypto/commitment');

    render(<VotePage />);

    // Select option C
    await user.click(screen.getByLabelText(/Option C/i));

    // Click vote button
    await user.click(screen.getByRole('button', { name: /投票|Vote/i }));

    // Check commitment was generated with correct vote and electionId
    await waitFor(() => {
      expect(generateCommitment).toHaveBeenCalledWith('C', '550e8400-e29b-41d4-a716-446655440000');
    });
  });

  it('should save vote data to localStorage', async () => {
    const user = userEvent.setup();
    const { saveSessionData } = await import('@/lib/session');

    render(<VotePage />);

    // Select option D
    await user.click(screen.getByLabelText(/Option D/i));

    // Click vote button
    await user.click(screen.getByRole('button', { name: /投票|Vote/i }));

    // Check session data was saved
    await waitFor(() => {
      expect(saveSessionData).toHaveBeenCalledWith({
        myVote: 'D',
        myCommit: 'test-commitment',
        myRand: 'test-random',
      });
    });
  });

  it('should call vote API with commitment', async () => {
    const user = userEvent.setup();
    render(<VotePage />);

    // Select option E
    await user.click(screen.getByLabelText(/Option E/i));

    // Click vote button
    await user.click(screen.getByRole('button', { name: /投票|Vote/i }));

    // Check API was called
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/vote', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': 'test-session-id',
          'X-Session-Capability': 'test-capability-token',
        },
        body: JSON.stringify({
          commitment: 'test-commitment',
          vote: 'E',
          rand: 'test-random',
          turnstileToken: 'test-turnstile-token',
        }),
      });
    });
  });

  it('should save vote receipt data after successful API call', async () => {
    const user = userEvent.setup();
    const { saveSessionData } = await import('@/lib/session');

    render(<VotePage />);

    // Select option A
    await user.click(screen.getByLabelText(/Option A/i));

    // Click vote button
    await user.click(screen.getByRole('button', { name: /投票|Vote/i }));

    // Check vote receipt was saved
    await waitFor(() => {
      expect(saveSessionData).toHaveBeenCalledWith({
        voteId: '550e8400-e29b-41d4-a716-446655440000',
        bulletinIndex: 0,
        bulletinRootAtCast: '0x' + 'a'.repeat(64),
      });
    });
  });

  it('should store vote timestamp in knowledge data when provided', async () => {
    const user = userEvent.setup();
    const { saveKnowledgeData } = await import('@/lib/knowledge');

    render(<VotePage />);

    await user.click(screen.getByLabelText(/Option A/i));
    await user.click(screen.getByRole('button', { name: /投票|Vote/i }));

    await waitFor(() => {
      expect(saveKnowledgeData).toHaveBeenCalledWith(
        expect.objectContaining({
          'user.voteTimestamp': 1730000000000,
        }),
      );
    });
  });

  it('should navigate to waiting page after successful vote', async () => {
    const user = userEvent.setup();
    render(<VotePage />);

    // Select option B
    await user.click(screen.getByLabelText(/Option B/i));

    // Click vote button
    await user.click(screen.getByRole('button', { name: /投票|Vote/i }));

    // Check navigation
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/vote#waiting');
    });
  });

  it('should show waiting screen after successful vote', async () => {
    const user = userEvent.setup();
    render(<VotePage />);

    await user.click(screen.getByLabelText(/Option A/i));
    await user.click(screen.getByRole('button', { name: /投票|Vote/i }));

    await waitFor(() => {
      // BotVotingProgress component shows "Processing..." text
      expect(screen.getByText(/Processing\.\.\./i)).toBeInTheDocument();
    });
  });

  it('should show loading state while submitting', async () => {
    const user = userEvent.setup();
    type VoteApiResponse = {
      ok: boolean;
      json: () => Promise<{ data: { voteId: string; bulletinIndex: number; bulletinRootAtCast: string } }>;
    };

    // Delay the API response
    mockFetch.mockImplementationOnce(() => new Promise<VoteApiResponse>(() => {}));

    render(<VotePage />);

    // Select option and submit
    await user.click(screen.getByLabelText(/Option A/i));
    const voteButton = screen.getByRole('button', { name: /投票|Vote/i });

    await user.click(voteButton);

    // Button should show loading state
    expect(voteButton).toBeDisabled();
    expect(screen.getByText(/送信中|Submitting/i)).toBeInTheDocument();
  });

  it('should handle API errors gracefully', async () => {
    const user = userEvent.setup();

    // Mock API error
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Server error' }),
    });

    render(<VotePage />);

    // Select option and submit
    await user.click(screen.getByLabelText(/Option A/i));
    await user.click(screen.getByRole('button', { name: /投票|Vote/i }));

    // Check error message is displayed
    await waitFor(() => {
      expect(screen.getByText(/エラーが発生しました|An error occurred/i)).toBeInTheDocument();
    });

    // Should not navigate
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('should handle network errors', async () => {
    const user = userEvent.setup();

    // Mock network error
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    render(<VotePage />);

    // Select option and submit
    await user.click(screen.getByLabelText(/Option A/i));
    await user.click(screen.getByRole('button', { name: /投票|Vote/i }));

    // Check error message is displayed
    await waitFor(() => {
      expect(screen.getByText(/ネットワークエラー|Network error/i)).toBeInTheDocument();
    });
  });

  describe('hash-based routing', () => {
    it('should display waiting screen when hash is #waiting', async () => {
      window.location.hash = '#waiting';

      act(() => {
        render(<VotePage />);
      });

      // Should display waiting progress component with "Processing..." text
      await waitFor(() => {
        expect(screen.getByText(/Processing\.\.\./i)).toBeInTheDocument();
      });
    }, 10000); // Increase timeout to 10 seconds

    it('should display vote form when hash is empty', () => {
      // Mock window.location.hash
      Object.defineProperty(window, 'location', {
        value: { hash: '' },
        writable: true,
      });

      render(<VotePage />);

      // Should display vote form
      expect(screen.getByRole('button', { name: /Vote/i })).toBeInTheDocument();
      expect(screen.getByRole('radiogroup')).toBeInTheDocument();
    });
  });
});
