import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect, useRef } from 'react';
import { VoteForm } from './VoteForm';
import { generateCommitment } from '@/lib/crypto/commitment';
import { getSessionAuthHeaders, getSessionData } from '@/lib/session';
import { apiFetch } from '@/lib/api/apiFetch';

vi.mock('@/lib/hooks', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/components/security/TurnstileWidget', () => ({
  TurnstileWidget: ({
    onTokenChange,
    disabled,
  }: {
    onTokenChange: (token: string | null) => void;
    disabled?: boolean;
  }) => {
    const didEmitRef = useRef(false);
    useEffect(() => {
      if (!disabled && !didEmitRef.current) {
        didEmitRef.current = true;
        onTokenChange('turnstile-token');
      }
    }, [disabled, onTokenChange]);
    return <div data-testid="turnstile-widget" />;
  },
}));

vi.mock('@/lib/crypto/commitment', () => ({
  generateCommitment: vi.fn(),
}));

vi.mock('@/lib/session', () => ({
  getSessionAuthHeaders: vi.fn(),
  getSessionData: vi.fn(),
  saveSessionData: vi.fn(),
}));

vi.mock('@/lib/knowledge', () => ({
  saveKnowledgeData: vi.fn(),
}));

vi.mock('@/lib/api/apiFetch', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/lib/api/apiBaseUrl', () => ({
  resolveApiUrl: (path: string) => path,
}));

describe('VoteForm', () => {
  const onVoteComplete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionData).mockReturnValue({
      sessionId: 'session-123',
      capabilityToken: 'test-capability-token',
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      lastActivity: Date.now(),
    });
    vi.mocked(getSessionAuthHeaders).mockReturnValue({
      'X-Session-ID': 'session-123',
      'X-Session-Capability': 'test-capability-token',
    });
    vi.mocked(generateCommitment).mockResolvedValue({
      commitment: '0x' + '1'.repeat(64),
      randomValue: '0x' + '2'.repeat(64),
    });
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            voteId: '550e8400-e29b-41d4-a716-446655440000',
            bulletinIndex: 1,
            bulletinRootAtCast: '0x' + '1'.repeat(64),
            timestamp: 1234567890,
          },
        }),
    } as Response);
  });

  it('keeps submit button disabled after successful vote submission', async () => {
    const user = userEvent.setup();
    render(<VoteForm onVoteComplete={onVoteComplete} />);

    await user.click(screen.getByTestId('vote-option-A'));

    const submitButton = screen.getByTestId('submit-vote');
    await waitFor(() => expect(submitButton).toBeEnabled());

    await user.click(submitButton);

    await waitFor(() => {
      expect(onVoteComplete).toHaveBeenCalled();
    });

    expect(screen.getByTestId('submit-vote')).toBeDisabled();
  });

  it('scrolls to the bottom after selecting a vote option', async () => {
    const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const user = userEvent.setup();

    try {
      render(<VoteForm onVoteComplete={onVoteComplete} />);

      await user.click(screen.getByTestId('vote-option-A'));

      await waitFor(() => {
        expect(scrollToSpy).toHaveBeenCalled();
      });
    } finally {
      scrollToSpy.mockRestore();
    }
  });
});
